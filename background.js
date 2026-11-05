import { BUNDLED_API_KEY } from './config.js'
import { parsePlaylistUrl, playlistUrl } from './lib/parseUrl.js'
import { loadPlaylistTracks, requireApiKey } from './lib/api.js'
import { YoutubeApiError, codeOf } from './lib/errors.js'
import { generateQueue } from './lib/shuffle/index.js'
import { DEFAULT_SETTINGS } from './lib/types.js'

const SETTINGS_KEY = 'settings'
const PLAYLISTS_KEY = 'playlists'
const QUEUE_KEY = 'queueState'
const PLAYBACK_KEY = 'playback'

// ---------------------------------------------------------------------------
// Storage helpers. MV3 workers die between events, so ALL state lives in
// chrome.storage (local for durable config, session for the active queue).
// ---------------------------------------------------------------------------

async function storageGet(area, key, fallback) {
  const result = await chrome.storage[area].get(key)
  return result[key] ?? fallback
}

async function storageSet(area, key, value) {
  await chrome.storage[area].set({ [key]: value })
}

function mergeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
}

async function getSettings() {
  return mergeSettings(await storageGet('local', SETTINGS_KEY, undefined))
}

async function saveSettings(settings) {
  await storageSet('local', SETTINGS_KEY, settings)
}

function getPlaylists() {
  return storageGet('local', PLAYLISTS_KEY, [])
}

async function savePlaylists(list) {
  await storageSet('local', PLAYLISTS_KEY, list)
}

function getQueueState() {
  return storageGet('session', QUEUE_KEY, undefined)
}

async function saveQueueState(state) {
  await storageSet('session', QUEUE_KEY, state)
}

function getPlayback() {
  return storageGet('session', PLAYBACK_KEY, {
    playing: false,
    tabId: null,
    videoId: null, // last videoId known to be on the playback tab
  })
}

async function savePlayback(playback) {
  await storageSet('session', PLAYBACK_KEY, playback)
}

// ---------------------------------------------------------------------------
// Unavailability watchdog. The content script's DOM probes (.ytp-error,
// getPlayerError, dead pause timers) can all fail exactly when the player is
// broken, so the worker keeps its own safety net: every track the worker
// COMMANDS must CONFIRM it is playing (`play-state {playing:true}` from the
// playback tab). A track left unconfirmed for PENDING_WATCH_MS is marked
// unavailable and skipped — with a real RELOAD, in case the previous one left
// the player in a dead state that swallows loadVideoById.
// ---------------------------------------------------------------------------

const PENDING_WATCH_MS = 25000
const PENDING_ALARM = 'ypr-pending-watch'

async function clearPendingWatch(playback) {
  // console.log('[YPR] pending cleared (was', playback?.pendingVideoId ?? 'none' + ')')
  await savePlayback({ ...playback, pendingVideoId: null, pendingAt: null })
}

async function armPendingWatch(videoId) {
  if (!videoId) return
  // console.log('[YPR] pending armed for', videoId)
  await savePlayback({ ...(await getPlayback()), pendingVideoId: videoId, pendingAt: Date.now() })
  try {
    await chrome.alarms.create(PENDING_ALARM, { when: Date.now() + PENDING_WATCH_MS })
  } catch {
    // No alarms API in this runtime: the content-side detection stays alone.
  }
}

/**
 * Mark a videoId unavailable in EVERY stored playlist (the queue generator and
 * the skip logic honor it) — the persistence half of every skip path.
 */
async function markTrackUnavailable(videoId) {
  if (!videoId) return false
  const playlists = await getPlaylists()
  let touched = false
  for (const playlist of playlists) {
    for (const track of playlist.tracks ?? []) {
      if (track.id === videoId && track.available) {
        track.available = false
        touched = true
      }
    }
  }
  if (touched) {
    await savePlaylists(playlists)
  }
  return touched
}

// ---------------------------------------------------------------------------
// Playback plumbing
// ---------------------------------------------------------------------------

function watchUrl(site, videoId) {
  const host = site === 'music' ? 'music.youtube.com' : 'www.youtube.com'
  return `https://${host}/watch?v=${videoId}`
}

async function currentTrack() {
  const queue = await getQueueState()
  if (!queue?.queue?.length) return undefined
  return queue.queue[queue.index ?? 0]
}

/**
 * Live truth from a tab's page: which video the player is REALLY on (and
 * whether it is playing). Tab URLs go STALE once tracks are switched in
 * place (`movie_player.loadVideoById` never updates the URL), so URL-only
 * ownership checks misroute queue clicks to a fresh tab. Best-effort probe:
 * returns null when the content script is unreachable.
 */
async function probePageState(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'get-page-state' })
    if (!reply?.ok || !reply.videoId) return null
    return { videoId: reply.videoId, playing: Boolean(reply.playing) }
  } catch {
    return null
  }
}

// Both YouTube flavors count as "YouTube" everywhere: the worker must be
// blind ONLY to non-YouTube tabs, never to the wrong YouTube flavor (the
// user may play on www.youtube.com while the site setting says music, or
// vice versa — filtering queries by the configured host made the worker
// miss the actually-playing tab and spawn a second one).
const YT_URL_PATTERNS = ['https://www.youtube.com/*', 'https://music.youtube.com/*']

function ytHostname(url) {
  if (!url) return null
  try {
    const host = new URL(url).hostname
    return host === 'www.youtube.com' || host === 'music.youtube.com' ? host : null
  } catch {
    return null
  }
}

/**
 * Resolve the playlist's playback tab and return { tab, fresh }.
 * Priority (first hit wins):
 *   1. The KNOWN playback tab (playback.tabId) while it is any YouTube page.
 *   2. A visible YouTube tab already on a queue track (by URL) — MIRROR RULE.
 *   3. A YouTube tab whose PLAYER (live probe) is on queue music — active
 *      tabs first, background tabs after (the tab URL is unreliable after
 *      in-place loadVideoById switches).
 *   4. Any background YouTube tab (navigate it, never hijack the visible one).
 *   5. A dedicated background playback tab on the current track.
 * The configured site only decides the URL of freshly created tabs.
 */
async function ensurePlaybackTab(site, activateOnCreate = false) {
  const playback = await getPlayback()
  const track = await currentTrack()
  const targetUrl = watchUrl(site, track?.id ?? '')

  const queue = await getQueueState()
  const queueIds = new Set((queue?.queue ?? []).map((t) => t.id))

  const claim = async (tab, why) => {
    // console.log('[YPR] tab claimed:', why, 'tabId=', tab?.id)
    if (tab?.id !== playback.tabId) {
      await savePlayback({ ...(await getPlayback()), tabId: tab.id, lostControl: false })
    }
    return { tab, fresh: false }
  }

  // 1) Known playback tab — but VERIFIED, not blind: the recorded tabId may
  //    long ago have been taken back by the user (it would then redirect
  //    elsewhere and spawn a second tab while the queue keeps playing in the
  //    user's visible one). Keep it unless the page definitively reports a
  //    foreign video (live probe answered with a video outside the queue).
  if (playback.tabId != null) {
    let tab = null
    try {
      tab = await chrome.tabs.get(playback.tabId)
    } catch {
      // console.log('[YPR] known playback tab is gone')
    }
    if (tab) {
      const host = ytHostname(tab.url)
      if (host === null && tab.url) {
        // console.log('[YPR] known playback tab is not YouTube anymore:', tab.url)
      } else if (!tab.url) {
        return await claim(tab, 'known-playback-tab-loading')
      } else {
        const live = await probePageState(tab.id)
        const contradicted = Boolean(
          live &&
            !queueIds.has(live.videoId) &&
            live.videoId !== playback.videoId &&
            live.videoId !== track?.id,
        )
        if (!contradicted) {
          return await claim(tab, live ? 'known-playback-tab-verified' : 'known-playback-tab')
        }
        // console.log('[YPR] known playback tab was taken back (page video:', live.videoId + ')')
      }
    }
  }

  const candidates = await chrome.tabs.query({ url: YT_URL_PATTERNS }).catch(() => [])

  const onQueueUrl = (tab) => {
    if (!tab?.active) return false
    const v = ytHostname(tab.url) ? (new URL(tab.url).searchParams.get('v') ?? '') : ''
    return Boolean(v && queueIds.has(v))
  }

  // 2) URL pass: visible tab on a queue track is THE playback tab.
  const focused = await chrome.tabs
    .query({ url: YT_URL_PATTERNS, active: true, lastFocusedWindow: true })
    .catch(() => [])
  const focusHit = focused.find(onQueueUrl)
  if (focusHit) return await claim(focusHit, 'focused-tab-on-queue-track-url')
  const activeHit = candidates.find(onQueueUrl)
  if (activeHit) return await claim(activeHit, 'active-tab-on-queue-track-url')
  const bgUrlHit = candidates.find(
    (t) =>
      !t.active &&
      ytHostname(t.url) &&
      queueIds.has(new URL(t.url).searchParams.get('v') ?? ''),
  )
  if (bgUrlHit) return await claim(bgUrlHit, 'background-tab-on-queue-track-url')

  // 3) LIVE probe pass: what each YouTube page is REALLY watching. The URL
  //    goes stale after in-place loadVideoById switches and after queue
  //    regeneration, so this catches the visible playing tab even when every
  //    URL check fails. A foreign videoId is NEVER claimed (anti-hijack).
  const holdsOurMusicLive = (live) =>
    Boolean(live && (queueIds.has(live.videoId) || live.videoId === playback.videoId))
  const holders = []
  for (const tab of candidates) {
    const live = await probePageState(tab.id)
    if (holdsOurMusicLive(live)) holders.push(tab)
  }
  const holderActive = holders.find((t) => t.active)
  if (holderActive) return await claim(holderActive, 'live-probe-active-tab-holds-queue-music')
  const holderBg = holders.find((t) => !t.active)
  if (holderBg) return await claim(holderBg, 'live-probe-background-tab-holds-queue-music')

  // 4) Any background YouTube tab: reuse it instead of spawning a new one.
  const bgAny = candidates.find((t) => !t.active)
  if (bgAny) return await claim(bgAny, 'any-background-youtube-tab')

  // 5) The only YouTube tab is the one the user is LOOKING at and it does
  //    not hold queue music: leave it alone and open a dedicated background
  //    playback tab on the current track.
  if (candidates.length > 0) {
    const tab = await chrome.tabs.create({ url: targetUrl, active: false })
    await savePlayback({ ...(await getPlayback()), tabId: tab.id })
    // console.log('[YPR] dedicated background playback tab created:', tab.id)
    return { tab, fresh: true }
  }

  // No suitable tab: create one already on the current track.
  const tab = await chrome.tabs.create({ url: targetUrl, active: activateOnCreate })
  await savePlayback({ ...(await getPlayback()), tabId: tab.id })
  // console.log('[YPR] fresh playback tab created:', tab.id)
  return { tab, fresh: true }
}

/**
 * THE playback path: hand the track to YouTube's own player of the resolved
 * playback tab — in place (`play-track`) when that tab already holds the
 * queue's music, otherwise a native navigation to `watch?v=<id>`.
 *
 * ANTI-HIJACK: the stored playback tab may long ago have been taken back by
 * the user (they browse YouTube in it now). When the tab about to receive
 * the queue's track is the one they are LOOKING at and it does not hold the
 * queue's music (live player probe first, URL as fallback), it is refused
 * and the track goes to another background tab / a dedicated background tab.
 *
 * The navigation URL keeps the TARGET tab's own YouTube flavor (www vs
 * music): switching tracks must never silently turn a music playlist page
 * into a regular youtube.com one.
 */
async function navigateToCurrentTrack(tabId) {
  const track = await currentTrack()
  if (!track?.id) return
  const settings = await getSettings()
  const playback = await getPlayback()

  let targetId = tabId
  let targetTab = null
  try {
    targetTab = await chrome.tabs.get(targetId)
  } catch {
    targetTab = null
  }
  let fg = null
  try {
    const looked = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    fg = looked?.[0] ?? null
  } catch {
    // No focused window (screen locked, minimized): nothing to preserve.
  }

  // LIVE TRUTH first: ask the page's own player which video it is REALLY on
  // (tab URLs go stale after in-place loadVideoById switches, so a URL lookup
  // alone misroutes the click to a fresh tab). Fall back to the tab's URL
  // only when the content script is unreachable (extension reloaded, etc.).
  const live = await probePageState(targetId)
  const urlVideo = targetTab?.url ? (new URL(targetTab.url).searchParams.get('v') ?? null) : null
  const pageVideo = live?.videoId ?? urlVideo

  let queueIds = new Set()
  try {
    const queue = await getQueueState()
    queueIds = new Set((queue?.queue ?? []).map((t) => t.id))
  } catch {
    // Queue unavailable: fall back to the recorded video only.
  }
  // The queue's music lives in a tab holding ANY queue track (or the worker's
  // recorded one — or the exact track being commanded): clicking a queue song
  // while LOOKING at the playing tab must change the song THERE, never spawn
  // another tab.
  const holdsOurMusic =
    pageVideo !== null &&
    (queueIds.has(pageVideo) || pageVideo === playback.videoId || pageVideo === track.id)

  /* console.log(
    '[YPR] play resolve:',
    'tab=', targetId,
    'live=', live?.videoId ?? '(no probe)',
    'url=', urlVideo ?? '(no url)',
    'target=', track.id,
    'holdsOurMusic=', holdsOurMusic,
  ) */

  // SAME-TAB IN-PLACE TRACK CHANGE: if this tab already holds the queue's
  // music, hand the track to the page's own player (loadVideoById). This is
  // immune to every tab-routing edge case: no navigation, no tab resolution,
  // nothing to redirect — the song changes where the playlist is playing.
  // SKIPPED when the watchdog flagged the player as possibly dead: then the
  // retry must be a real RELOAD that remounts a fresh player.
  let playbackNow = await getPlayback()
  if ((targetTab?.url || live) && holdsOurMusic && !playbackNow.forceNavigation) {
    try {
      const reply = await chrome.tabs.sendMessage(targetId, {
        type: 'play-track',
        videoId: track.id,
      })
      if (reply?.ok) {
        await savePlayback({
          ...playbackNow,
          tabId: targetId,
          videoId: track.id,
          lostControl: false,
        })
        // console.log('[YPR] played IN PLACE (loadVideoById) in tab', targetId)
        await armPendingWatch(track.id)
        return
      }
      // Player unavailable: fall through to the navigation path.
    } catch {
      // Content script not reachable: fall through to the navigation path.
    }
  }

  // Dead/unknown tab, or the visible tab no longer holds the queue's music:
  // the worker's tab state must lose against what the user is actually
  // seeing. Re-resolve: another background tab on the right host (never the
  // visible one) or a dedicated background playback tab.
  if (!targetTab?.url || (fg && fg.id === targetId && !holdsOurMusic)) {
    const tabHost = ytHostname(targetTab?.url ?? '')
    if (tabHost === null) {
      /* console.log('[YPR] target tab had no YouTube URL:', targetTab?.url) */
    }
    const alt = await chrome.tabs
      .query({ url: YT_URL_PATTERNS })
      .then(
        (tabs) =>
          tabs.find(
            (t) =>
              !t.active &&
              t.id !== targetId &&
              (tabHost === null || ytHostname(t.url) === tabHost),
          ),
      )
      .catch(() => undefined)
    if (alt) {
      targetId = alt.id
      // console.log('[YPR] redirected to background tab', targetId)
    } else {
      const fresh = await chrome.tabs.create({
        url: watchUrl(tabHost === 'music.youtube.com' ? 'music' : settings.site, track.id),
        active: false,
      })
      targetId = fresh.id
      // console.log('[YPR] fresh playback tab created in redirect:', targetId)
    }
    await savePlayback({
      ...playback,
      tabId: targetId,
      videoId: track.id,
      lostControl: false,
      forceNavigation: null,
    })
  } else {
    // OWN navigation: always takes ownership back (e.g. lostControl backoff).
    await savePlayback({
      ...playback,
      videoId: track.id,
      lostControl: false,
      forceNavigation: null,
    })
    // console.log('[YPR] navigating OUR playback tab', targetId)
  }

  // Navigation keeps the FINAL target tab's own YouTube flavor (www vs
  // music): after a redirect the destination != the original target, so
  // re-read the tab rather than reusing the stale URL view.
  let hostNow = ytHostname(targetTab?.url ?? '')
  if (hostNow === null || targetId !== targetTab?.id) {
    try {
      const finalTab = await chrome.tabs.get(targetId)
      hostNow = ytHostname(finalTab?.url ?? '')
    } catch {
      hostNow = null
    }
  }
  const navHost =
    hostNow === 'music.youtube.com'
      ? 'music'
      : hostNow === 'www.youtube.com'
        ? 'youtube'
        : settings.site
  await chrome.tabs.update(targetId, { url: watchUrl(navHost, track.id) })
  await armPendingWatch(track.id)

  // FOCUS PRESERVATION: if something raises the playback tab after this
  // navigation (Chrome can, even for a background tabs.update), hand the
  // user's view back. A focus change to any OTHER tab is user action.
  if (!fg || fg.id === targetId) return
  for (const delay of [500, 1500, 3000, 6000]) {
    setTimeout(() => {
      void (async () => {
        try {
          const still = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
          const active = still?.[0]
          if (!active || active.id === fg.id) return // focus back on the user
          if (active.id !== targetId) return // user moved elsewhere: respect it
          await chrome.tabs.update(fg.id, { active: true })
          await chrome.windows.update(fg.windowId, { focused: true })
        } catch {
          // Captured tab/window may be gone; best effort only.
        }
      })()
    }, delay)
  }
}

/** Resume playback of the track already loaded in the tab, without navigating. */
async function tryResumeInPlace(playback, track) {
  if (playback.tabId == null || playback.videoId !== track.id) return false
  try {
    await chrome.tabs.sendMessage(playback.tabId, { type: 'resume-video' })
    return true
  } catch {
    return false
  }
}

/** Advance to the next queue entry, reusing the normal playback path. */
async function advanceQueue(tabId) {
  const queue = await getQueueState()
  if (!queue?.queue?.length) return { action: 'idle' }

  // Skip past EVERY consecutively unavailable track: one broken video must
  // never strand the queue on the next broken one either.
  let nextIndex = (queue.index ?? 0) + 1
  while (nextIndex < queue.queue.length && queue.queue[nextIndex].available === false) {
    nextIndex += 1
  }
  if (nextIndex >= queue.queue.length) {
    const playback = await getPlayback()
    await savePlayback({ ...playback, playing: false, pendingVideoId: null, pendingAt: null })
    return { action: 'queue-end', index: queue.index ?? 0, total: queue.queue.length }
  }

  queue.index = nextIndex
  await saveQueueState(queue)

  const playback = await getPlayback()
  const current = queue.queue[nextIndex]
  // A COMMAND-BUT-NEVER-CONFIRMED track poisons `playing` on the way out
  // (teardown `pause` events of the previous page report a user pause that
  // never happened). When the queue has just moved PAST such a slot (the
  // unconfirmed command no longer matches the current entry), it must keep
  // moving ON regardless: nobody can pause a track that never played.
  const neverConfirmed =
    Boolean(playback.pendingVideoId) && playback.pendingVideoId !== current.id
  if (playback.playing || neverConfirmed) {
    const targetId = playback.tabId ?? tabId
    if (targetId != null) {
      try {
        await navigateToCurrentTrack(targetId)
      } catch {
        // The playback tab died mid-queue: re-resolve it without hijacking
        // the tab the user is looking at.
        const { tab } = await ensurePlaybackTab((await getSettings()).site)
        await navigateToCurrentTrack(tab.id)
      }
    }
  }
  return { action: 'next', index: nextIndex, videoId: current.id }
}

/**
 * A track cannot be played on the site (hidden/unavailable). Mark the track in
 * every stored playlist as unavailable (the dedupe/available filter honours it)
 * and skip it like a normal end-of-track.
 */
async function handleTrackSkip(tabId, videoId) {
  // console.log('[YPR] player-error arrived: marking + skipping', videoId)
  await markTrackUnavailable(videoId)

  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ignore-ended', videoId })
    } catch { /* best effort */ }
  }
  return advanceQueue(tabId)
}

/** Pause only a tab that genuinely holds the queue's track (LIVE evidence). */
async function pausePlaybackTab() {
  const playback = await getPlayback()
  if (playback.tabId == null) return false
  try {
    const tab = await chrome.tabs.get(playback.tabId)
    const pageVideo = tab?.url ? (new URL(tab.url).searchParams.get('v') ?? null) : null
    if (pageVideo && playback.videoId && pageVideo !== playback.videoId) {
      // The tab switched tracks IN PLACE earlier, so its URL shows an older
      // queue track — that is still our music, never skip the pause.
      let stillOurs = false
      try {
        const queue = await getQueueState()
        stillOurs = (queue?.queue ?? []).some((t) => t.id === pageVideo)
      } catch {
        stillOurs = false
      }
      if (!stillOurs) return false // the user took this tab back
    }
    await chrome.tabs.sendMessage(playback.tabId, { type: 'pause-video' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Playlist management
// ---------------------------------------------------------------------------

async function newPlaylist(playlistId, apiKey, labelFallbackPrefix) {
  const fallbacks = {
    untitled: ui('untitled'),
    unknownChannel: ui('unknown_channel'),
  }
  const { tracks, label } = await loadPlaylistTracks(playlistId, apiKey, fallbacks)

  const existing = await getPlaylists()
  const defaultLabel = label ?? `${labelFallbackPrefix} ${existing.length + 1}`

  return {
    id: playlistId,
    label: defaultLabel,
    url: playlistUrl(playlistId),
    tracks,
    loadedAt: Date.now(),
    active: true,
  }
}

function ui(key, args) {
  return chrome.i18n.getMessage(key, args) ?? ''
}

async function loadOrCreatePlaylist(url) {
  const parsed = parsePlaylistUrl(url)
  if (!parsed.ok) {
    throw new YoutubeApiError(parsed.reason)
  }

  const settings = await getSettings()
  const apiKey = requireApiKey(settings.apiKey, BUNDLED_API_KEY)
  const playlists = await getPlaylists()
  const existingIndex = playlists.findIndex((p) => p.id === parsed.playlistId)

  const playlist = await newPlaylist(parsed.playlistId, apiKey, ui('default_playlist_label'))

  if (existingIndex >= 0) {
    playlist.label = playlists[existingIndex].label || playlist.label
    playlists[existingIndex] = playlist
  } else {
    playlists.push(playlist)
  }
  await savePlaylists(playlists)

  return playlist
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

async function sendMessageToPlaybackTab(message) {
  const playback = await getPlayback()
  if (playback.tabId == null) return false
  try {
    await chrome.tabs.sendMessage(playback.tabId, message)
    return true
  } catch {
    return false
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    // ---------------------------------------------------------------- settings
    case 'get-state': {
      const [settings, playlists, queue, playback] = await Promise.all([
        getSettings(),
        getPlaylists(),
        getQueueState(),
        getPlayback(),
      ])
      let tabMissing = false
      if (playback.tabId != null) {
        try { await chrome.tabs.get(playback.tabId) } catch { tabMissing = true }
      }
      return {
        ok: true,
        settings,
        playlists: playlists.map((p) => ({
          id: p.id,
          label: p.label,
          url: p.url,
          loadedAt: p.loadedAt,
          active: p.active,
          trackCount: (p.tracks ?? []).length,
          availableCount: (p.tracks ?? []).filter((t) => t.available).length,
        })),
        queue,
        playback: { ...playback, tabMissing },
      }
    }

    case 'set-settings': {
      const settings = await getSettings()
      const next = mergeSettings({ ...settings, ...message.patch })
      await saveSettings(next)
      return { ok: true, settings: next }
    }

    case 'get-effective-key': {
      const settings = await getSettings()
      const missing = !String(settings.apiKey || '').trim() && !BUNDLED_API_KEY
      return { ok: true, apiKey: settings.apiKey || BUNDLED_API_KEY, missing }
    }

    // -------------------------------------------------------------- playlists
    case 'add-playlist': {
      const playlist = await loadOrCreatePlaylist(message.url)
      return {
        ok: true,
        playlist: { ...playlist, tracks: undefined, trackCount: playlist.tracks.length },
      }
    }

    case 'refresh-playlist': {
      const playlists = await getPlaylists()
      const target = playlists.find((p) => p.id === message.id)
      if (!target) throw new YoutubeApiError('playlist-not-found')
      const settings = await getSettings()
      const apiKey = requireApiKey(settings.apiKey, BUNDLED_API_KEY)
      const fallbacks = { untitled: ui('untitled'), unknownChannel: ui('unknown_channel') }
      const { tracks } = await loadPlaylistTracks(target.id, apiKey, fallbacks)
      target.tracks = tracks
      target.loadedAt = Date.now()
      await savePlaylists(playlists)
      return { ok: true, trackCount: tracks.length }
    }

    case 'remove-playlist': {
      const playlists = await getPlaylists()
      await savePlaylists(playlists.filter((p) => p.id !== message.id))
      return { ok: true }
    }

    case 'set-playlist-active': {
      const playlists = await getPlaylists()
      const target = playlists.find((p) => p.id === message.id)
      if (target) {
        target.active = Boolean(message.active)
        target.label = message.label?.trim() ? message.label.trim().slice(0, 64) : target.label
        await savePlaylists(playlists)
      }
      return { ok: true }
    }

    // -------------------------------------------------------- queue + playback
    case 'shuffle': {
      // Playlists que participan en la mezcla = las marcadas como activas.
      // IMPORTANTE: se guardan todas, solo se mezclan las activas (bug: antes
      // se persistía la lista filtrada y borraba las no marcadas).
      const settings = await getSettings()
      const allPlaylists = await getPlaylists()
      const active = allPlaylists.filter((p) => p.active)
      if (active.length === 0) {
        throw new YoutubeApiError('no-active-playlists')
      }

      // Reload tracks for brand-new or emptied playlists before mixing.
      const apiKey = requireApiKey(settings.apiKey, BUNDLED_API_KEY)
      const fallbacks = { untitled: ui('untitled'), unknownChannel: ui('unknown_channel') }
      for (const playlist of active) {
        if (!playlist.tracks?.length) {
          const { tracks } = await loadPlaylistTracks(playlist.id, apiKey, fallbacks)
          playlist.tracks = tracks
          playlist.loadedAt = Date.now()
        }
      }
      await savePlaylists(allPlaylists) // persist any reload above (full list!)

      const plain = active.filter((p) => (p.tracks ?? []).length > 0)
      const tracks = generateQueue(settings.mode, plain, {
        dedupe: settings.dedupe,
        reshuffleRounds: settings.reshuffleRounds,
      })
      if (tracks.length === 0) {
        throw new YoutubeApiError('no-tracks')
      }

      const queueState = {
        queue: tracks,
        index: 0,
        mode: settings.mode,
        generatedAt: Date.now(),
      }
      await saveQueueState(queueState)

      let playback = await getPlayback()
      playback = { ...playback, playing: false, videoId: null }
      await savePlayback(playback)

      if (message.andPlay) {
        // The user explicitly asked to play: a FRESH tab may be raised.
        const { tab, fresh } = await ensurePlaybackTab(settings.site, true)
        await savePlayback({ ...(await getPlayback()), playing: true })
        // A fresh tab already opens on the current watch URL; otherwise navigate.
        if (!fresh) await navigateToCurrentTrack(tab.id)
        // A fresh tab must still CONFIRM it actually started playing.
        await armPendingWatch((await currentTrack())?.id)
      }

      return { ok: true, count: tracks.length, mode: settings.mode }
    }

    case 'set-playing': {
      const playback = await getPlayback()
      const value = Boolean(message.value)
      if (value) {
        const queue = await getQueueState()
        if (!queue?.queue?.length) {
          throw new YoutubeApiError('no-queue')
        }
        // Never resume a track already marked unavailable (a broken video
        // would both pause the queue here AND re-target it on play): skip
        // forward to the first playable entry from the current position on.
        let skipIndex = queue.index ?? 0
        while (skipIndex < queue.queue.length && queue.queue[skipIndex].available === false) {
          skipIndex += 1
        }
        if (skipIndex >= queue.queue.length) {
          // Everything from here on is unavailable: end the queue cleanly.
          await savePlayback({ ...playback, playing: false })
          return { ok: true, queueEnded: true }
        }
        if (skipIndex !== queue.index) {
          queue.index = skipIndex
          await saveQueueState(queue)
        }
        const track = queue.queue[skipIndex]
        // The user pressed play: any previous accounted loss of this tab is over.
        await savePlayback({ ...playback, playing: true, lostControl: false })
        // The same video is still loaded in the playback tab: resume in place.
        if (await tryResumeInPlace(playback, track)) {
          await clearPendingWatch(await getPlayback())
          return { ok: true, resumed: true }
        }
        const settings = await getSettings()
        const { tab } = await ensurePlaybackTab(settings.site)
        await savePlayback({ ...(await getPlayback()), tabId: tab.id, playing: true })
        await navigateToCurrentTrack(tab.id)
      } else {
        await savePlayback({ ...playback, playing: false, lostControl: false })
        await pausePlaybackTab()
      }
      return { ok: true }
    }

    case 'next': {
      const playback = await getPlayback()
      let tabId = playback.tabId
      if (tabId != null) {
        try {
          await chrome.tabs.get(tabId)
        } catch {
          tabId = null // The playback tab is gone; re-resolve it.
        }
      }
      if (tabId == null) {
        tabId = (await ensurePlaybackTab((await getSettings()).site)).tab.id
      }
      return await advanceQueue(tabId)
    }

    case 'prev': {
      const queue = await getQueueState()
      if (!queue?.queue?.length) return { action: 'idle' }
      if ((queue.index ?? 0) > 0) queue.index -= 1
      await saveQueueState(queue)
      // Destructure: ensurePlaybackTab returns { tab, fresh }; passing the
      // wrapper's .id used to be undefined → a fresh tab on every click.
      const { tab } = await ensurePlaybackTab((await getSettings()).site)
      await savePlayback({ ...(await getPlayback()), playing: true })
      await navigateToCurrentTrack(tab.id)
      return { action: 'prev', index: queue.index }
    }

    case 'jump-to': {
      const queue = await getQueueState()
      if (!queue?.queue?.length) return { ok: false }
      const index = Math.max(0, Math.min(queue.queue.length - 1, Number(message.index) | 0))
      queue.index = index
      await saveQueueState(queue)
      // Destructure: ensurePlaybackTab returns { tab, fresh }; passing the
      // wrapper's .id used to be undefined → a fresh tab on every click.
      const { tab } = await ensurePlaybackTab((await getSettings()).site)
      await savePlayback({ ...(await getPlayback()), playing: true })
      await navigateToCurrentTrack(tab.id)
      return { ok: true, index }
    }

    // ----------------------------------------------------------- from content.js
    case 'get-media-session': {
      // Media keys (⏭/⏮/⏯) may bind ONLY while the tab genuinely belongs to the
      // shuffled queue: playback tab, on the queue's current track and with the
      // worker in control (no lostControl backoff).
      const [queue, playback] = await Promise.all([getQueueState(), getPlayback()])
      const current = queue?.queue?.[queue.index ?? 0]
      // The page's player reports its own video (message.videoId): tab URLs go
      // STALE once the plugin switches tracks in place via loadVideoById.
      const pageVideoId =
        message?.videoId ??
        (sender?.tab?.url
          ? (new URL(sender.tab.url).searchParams.get('v') ?? null)
          : null)
      const owned = Boolean(
        current &&
          playback.tabId != null &&
          sender?.tab?.id === playback.tabId &&
          !playback.lostControl &&
          current.id === pageVideoId,
      )
      // queuePlaying: the shuffled queue is actively playing in ITS tab.
      // Chrome may route a media key to whichever YouTube tab the user is
      // LOOKING at, so EVERY idle YouTube tab gets the ⏭/⏮ binding while the
      // queue plays — the key must reach the ONE playback tab, never spawn a
      // second playing tab. Content decides locally whether this tab is busy.
      const queuePlaying = Boolean(current && playback.playing && !playback.lostControl)
      return { ok: true, owned, queuePlaying }
    }

    case 'content-ready': {
      const playback = await getPlayback()
      const queue = await getQueueState()
      const track = queue?.queue?.[queue.index ?? 0]
      const pageVideoId = sender?.tab?.url
        ? (new URL(sender.tab.url).searchParams.get('v') ?? null)
        : null

      // The tab landed back on the queue's current track: the worker is
      // commanding it again, so any lostControl backoff is over.
      const pageMatchesQueue = Boolean(track && pageVideoId && track.id === pageVideoId)
      // tabId fencing: a random YouTube tab the user opens must NEVER steal
      // the playback role. Only the already-known playback tab — or a page
      // showing the queue's current track while no tab is known yet — may.
      const senderTabId = sender?.tab?.id ?? null
      const isKnownPlaybackTab = senderTabId != null && senderTabId === playback.tabId
      const takesOwnership = isKnownPlaybackTab || (playback.tabId == null && pageMatchesQueue)
      await savePlayback({
        ...playback,
        tabId: takesOwnership && senderTabId != null ? senderTabId : playback.tabId,
        videoId: takesOwnership ? (pageVideoId ?? playback.videoId) : playback.videoId,
        lostControl: pageMatchesQueue && takesOwnership ? false : playback.lostControl,
      })

      // Never navigate from here (that would reload forever): the page that just
      // loaded is nudged by content.js itself.
      if (track && playback.playing) {
        return { kick: true, videoId: track.id }
      }
      return { kick: false }
    }

    case 'play-state': {
      const playback = await getPlayback()
      // tabId fencing (see content-ready): pause/play events coming from a
      // random YouTube tab must never re-target the queue's playback tab or
      // pollute the queue's playing state — that is how "next" ended up
      // navigating the user's browsing tab instead of the music one.
      const senderTabId = sender?.tab?.id ?? null
      const isKnownPlaybackTab = senderTabId != null && senderTabId === playback.tabId
      const queue = await getQueueState()
      const current = queue?.queue?.[queue.index ?? 0]
      const trackMatches = Boolean(current && message.videoId && current.id === message.videoId)
      const takesOwnership = isKnownPlaybackTab || (playback.tabId == null && trackMatches)
      if (!takesOwnership) return { ok: true } // foreign tab: not our playback state
      // ONLY real time progress confirms a track is playable: a broken video
      // still fires `play` (fake playing state, zero bytes), so this message
      // must never clear the unavailability watchdog's pending.
      /* console.log(
        '[YPR] play-state:',
        'playing=', message.playing ?? '?',
        'videoId=', message.videoId ?? '?',
      ) */
      await savePlayback({
        ...playback,
        playing: message.playing ?? playback.playing,
        tabId: senderTabId ?? playback.tabId,
        videoId: message.videoId ?? playback.videoId,
      })
      return { ok: true }
    }

    case 'play-progress': {
      // The DEFINITIVE unavailability confirmation: actual currentTime
      // advances from the playback tab's own player.
      const playback = await getPlayback()
      const senderTabId = sender?.tab?.id ?? null
      const isKnownPlaybackTab = senderTabId != null && senderTabId === playback.tabId
      if (!isKnownPlaybackTab || !playback.pendingVideoId) return { ok: true }
      const currentTime = Number(message.currentTime) || 0
      if (message.videoId === playback.pendingVideoId && currentTime > 1) {
        // console.log('[YPR] play-progress confirms', message.videoId, 'at', currentTime)
        await clearPendingWatch(await getPlayback())
      }
      return { ok: true }
    }

    case 'track-ended': {
      const playback = await getPlayback()
      return await advanceQueue(playback.tabId ?? sender?.tab?.id ?? null)
    }

    case 'player-error': {
      const playback = await getPlayback()
      return await handleTrackSkip(playback.tabId ?? sender?.tab?.id ?? null, message.videoId)
    }

    case 'yt-navigation': {
      // The page moved to another video without our command: YouTube's own
      // autoplay grabbed it (we try to prevent it) or the user navigated.
      // Either way, stop commanding this tab until the user presses play again.
      const queue = await getQueueState()
      const current = queue?.queue?.[queue.index ?? 0]
      // owned: the page is exactly where the queue expects it (our own
      // navigation, normal case) — content.js uses that to bind or release the
      // media session keys.
      if (!current) return { ok: true, owned: false }
      if (current.id === message.videoId) return { ok: true, owned: true }

      const playback = await getPlayback()
      const touched = playback.tabId != null && sender?.tab?.id === playback.tabId
      if (touched && playback.playing) {
        await savePlayback({ ...playback, playing: false, lostControl: true })
      } else if (touched) {
        await savePlayback({ ...playback, lostControl: true })
      }
      return { ok: true, backoff: touched && playback.playing }
    }

    default:
      return { ok: false, code: 'unknown-message' }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      const code = codeOf(error)
      // console.log('[YPR] error', code, error?.message)
      sendResponse({ ok: false, code })
    })
  return true // async response
})

// UNAVAILABILITY WATCHDOG: a commanded track must CONFIRM it is playing
// (`play-state {playing:true, videoId}` from the playback tab). Anything
// left unconfirmed — hidden/unlisted/removed videos, dead players, a
// content script gone blind — is marked unavailable and skipped, and the
// retry forces a real RELOAD so a dead player cannot swallow the next one.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== PENDING_ALARM) return
  void (async () => {
    try {
      const playback = await getPlayback()
      const queue = await getQueueState()
      const current = queue?.queue?.[queue.index ?? 0]
      /* console.log(
        '[YPR] alarm fired:',
        'pending=', playback.pendingVideoId ?? '(none)',
        'current=', current?.id ?? '(no queue)',
        'playing=', playback.playing,
      ) */
      if (!playback.pendingVideoId) return
      if (!current || current.id !== playback.pendingVideoId) {
        // The queue already moved past what was commanded: stale pending.
        await clearPendingWatch(playback)
        return
      }
      // console.log('[YPR] watchdog: never confirmed playing, skipping:', current.id)
      await markTrackUnavailable(current.id)
      // Pending stays SET: advanceQueue's neverConfirmed gate relies on it
      // ("nobody can pause a track that never played") and the NEXT command
      // (armPendingWatch) replaces it. Force a real RELOAD on the retry: the
      // broken track may have left the player in a dead state that silently
      // swallows loadVideoById.
      await savePlayback({ ...(await getPlayback()), forceNavigation: true })
      await advanceQueue(playback.tabId)
    } catch (error) {
      // console.log('[YPR] watchdog error', codeOf(error))
    }
  })()
})

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const playback = await getPlayback()
  if (playback.tabId === tabId) {
    await savePlayback({ ...playback, tabId: null, playing: false })
  }
})

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings()
  if (JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS)) {
    await saveSettings(DEFAULT_SETTINGS)
  }
})
