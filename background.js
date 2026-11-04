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
 * Reuse the playback tab when alive and on the right host; otherwise activate the
 * first matching YouTube tab; otherwise open a new one pointed straight at the
 * current track (the site's own player autoplays it).
 * NEVER hijacks the tab the user is looking at: only background tabs are
 * reused, and fresh tabs can stay in the background too (activateOnCreate).
 */
async function ensurePlaybackTab(site, activateOnCreate = false) {
  const playback = await getPlayback()
  const host = site === 'music' ? 'music.youtube.com' : 'www.youtube.com'
  const pattern = `https://${host}/*`
  const track = await currentTrack()
  const targetUrl = watchUrl(site, track?.id ?? '')

  if (playback.tabId != null) {
    try {
      const tab = await chrome.tabs.get(playback.tabId)
      if (tab?.url && new URL(tab.url).hostname === host) return { tab, fresh: false }
    } catch {
      // Tab is gone; fall through to query.
    }
  }

  const candidates = await chrome.tabs.query({ url: pattern })
  // Prefer a background tab: navigating the visible tab would hijack it and
  // start a second playback.
  const background = candidates.find((t) => !t.active)
  if (background) {
    await savePlayback({ ...(await getPlayback()), tabId: background.id })
    return { tab: background, fresh: false }
  }
  if (candidates.length > 0) {
    // The only matching tab is the one the user is looking at: leave it alone
    // and open a dedicated background playback tab on the current track.
    const tab = await chrome.tabs.create({ url: targetUrl, active: false })
    await savePlayback({ ...(await getPlayback()), tabId: tab.id })
    return { tab, fresh: true }
  }

  // No suitable tab: create one already on the current track.
  const tab = await chrome.tabs.create({ url: targetUrl, active: activateOnCreate })
  await savePlayback({ ...(await getPlayback()), tabId: tab.id })
  return { tab, fresh: true }
}

/**
 * THE playback path: hand the track to YouTube's own player by navigating the
 * playback tab to its native watch URL (full reloads are fine).
 *
 * ANTI-HIJACK (the user reported a queue click NAVIGATING the tab they were
 * watching a video in): the stored playback tab may long ago have been taken
 * back by the user (they browse YouTube in it now). Trust only LIVE evidence:
 * if the tab about to receive the queue's track is the one they are LOOKING
 * at and it no longer shows the worker's recorded track, refuse to hijack it
 * and redirect to another background tab / a dedicated background tab.
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

  const pageVideo = targetTab?.url
    ? (new URL(targetTab.url).searchParams.get('v') ?? null)
    : null

  // Dead/unknown tab, or the visible tab no longer holds the queue's video:
  // the worker's tab state must lose against what the user is actually
  // seeing. Re-resolve: another background tab on the right host (never the
  // visible one) or a dedicated background playback tab.
  if (!targetTab?.url || (fg && fg.id === targetId && pageVideo !== playback.videoId)) {
    const host = settings.site === 'music' ? 'music.youtube.com' : 'www.youtube.com'
    const alt = await chrome.tabs
      .query({ url: `https://${host}/*` })
      .then((tabs) => tabs.find((t) => !t.active))
      .catch(() => undefined)
    if (alt && alt.id !== targetId) {
      targetId = alt.id
    } else {
      const fresh = await chrome.tabs.create({
        url: watchUrl(settings.site, track.id),
        active: false,
      })
      targetId = fresh.id
    }
    await savePlayback({ ...playback, tabId: targetId, videoId: track.id, lostControl: false })
  } else {
    // OWN navigation: always takes ownership back (e.g. lostControl backoff).
    await savePlayback({ ...playback, videoId: track.id, lostControl: false })
  }

  await chrome.tabs.update(targetId, { url: watchUrl(settings.site, track.id) })

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

  const nextIndex = (queue.index ?? 0) + 1
  if (nextIndex >= queue.queue.length) {
    const playback = await getPlayback()
    await savePlayback({ ...playback, playing: false })
    return { action: 'queue-end', index: queue.index ?? 0, total: queue.queue.length }
  }

  queue.index = nextIndex
  await saveQueueState(queue)

  const playback = await getPlayback()
  if (playback.playing) {
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
  return { action: 'next', index: nextIndex, videoId: queue.queue[nextIndex].id }
}

/**
 * A track cannot be played on the site (hidden/unavailable). Mark the track in
 * every stored playlist as unavailable (the dedupe/available filter honours it)
 * and skip it like a normal end-of-track.
 */
async function handleTrackSkip(tabId, videoId) {
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
      // The user took this tab back (shows another video): don't touch it.
      return false
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
        const track = queue.queue[queue.index ?? 0]
        // The user pressed play: any previous accounted loss of this tab is over.
        await savePlayback({ ...playback, playing: true, lostControl: false })
        // The same video is still loaded in the playback tab: resume in place.
        if (await tryResumeInPlace(playback, track)) return { ok: true, resumed: true }
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
      const playback = await getPlayback()
      if (!queue?.queue?.length) return { action: 'idle' }
      if ((queue.index ?? 0) > 0) queue.index -= 1
      await saveQueueState(queue)
      const tab = await ensurePlaybackTab((await getSettings()).site)
      await savePlayback({ ...(await getPlayback()), playing: true })
      await navigateToCurrentTrack(tab.id)
      return { action: 'prev', index: queue.index }
    }

    case 'jump-to': {
      const queue = await getQueueState()
      const playback = await getPlayback()
      if (!queue?.queue?.length) return { ok: false }
      const index = Math.max(0, Math.min(queue.queue.length - 1, Number(message.index) | 0))
      queue.index = index
      await saveQueueState(queue)
      const tab = await ensurePlaybackTab((await getSettings()).site)
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
      const pageVideoId = sender?.tab?.url
        ? (new URL(sender.tab.url).searchParams.get('v') ?? null)
        : null
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
      await savePlayback({
        ...playback,
        playing: message.playing ?? playback.playing,
        tabId: senderTabId ?? playback.tabId,
        videoId: message.videoId ?? playback.videoId,
      })
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
      console.log('[YPR] error', code, error?.message)
      sendResponse({ ok: false, code })
    })
  return true // async response
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
