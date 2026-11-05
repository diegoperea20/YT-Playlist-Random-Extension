/**
 * YT Playlist Random — popup logic.
 *
 * Thin view layer: every bit of state lives in the service worker and storage.
 * The popup asks for a snapshot (get-state), renders it, sends commands
 * (add/remove/shuffle/play controls) and re-renders on 1s polling.
 */

const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="icon"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'
const PLAY_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="icon"><path d="M8 5v14l11-7z"/></svg>'

const $ = (id) => document.getElementById(id)

const el = {
  optionsBtn: $('options-btn'),
  controls: $('controls-section'),
  diagLine: $('diag-line'),
  prevBtn: $('prev-btn'),
  playBtn: $('play-btn'),
  nextBtn: $('next-btn'),
  nowPlaying: $('now-playing'),
  queuePosition: $('queue-position'),
  queueSection: $('queue-section'),
  queueTitle: $('queue-title'),
  queueCount: $('queue-count'),
  queueList: $('queue-list'),
  urlInput: $('url-input'),
  addBtn: $('add-btn'),
  addError: $('add-error'),
  playlistsTitle: $('playlists-title'),
  refreshAllBtn: $('refresh-all-btn'),
  playlistsEmpty: $('playlists-empty'),
  playlistList: $('playlist-list'),
  modeTitle: $('mode-title'),
  modeList: $('mode-list'),
  dedupeToggle: $('dedupe-toggle'),
  dedupeLabel: $('dedupe-label'),
  dedupeDesc: $('dedupe-desc'),
  reshuffleToggle: $('reshuffle-toggle'),
  reshuffleLabel: $('reshuffle-label'),
  reshuffleDesc: $('reshuffle-desc'),
  mixPlayBtn: $('mix-play-btn'),
  mixBtn: $('mix-btn'),
  statusLine: $('status-line'),
  genError: $('gen-error'),
}

// ------------------------------------------------------------------- i18n

function t(key, args) {
  return chrome.i18n.getMessage(key, args ?? [])
}

function failText(code) {
  const key = `err_${String(code).replace(/-/g, '_')}`
  return t(key) || t('err_unknown') || code
}

function applyStaticI18n() {
  el.urlInput.placeholder = t('add_placeholder')
  el.addBtn.textContent = t('add_btn')
  el.playlistsTitle.textContent = t('playlists_title')
  el.refreshAllBtn.textContent = t('refresh_all')
  el.playlistsEmpty.textContent = t('playlists_empty')
  el.modeTitle.textContent = t('mode_title')
  el.dedupeLabel.textContent = t('dedupe')
  el.dedupeDesc.textContent = t('dedupe_desc')
  el.reshuffleLabel.textContent = t('reshuffle_rounds')
  el.reshuffleDesc.textContent = t('reshuffle_rounds_desc')
  el.mixPlayBtn.textContent = t('mix_play')
  el.mixBtn.textContent = t('mix_only')
  el.queueTitle.textContent = t('queue_title')
  el.optionsBtn.title = t('options_title')
  el.prevBtn.title = t('prev')
  el.nextBtn.title = t('next_title')
  // document.title = t('popup_title') — html <title> is not localized automatically.
}

// ------------------------------------------------------------------- state

let state = {
  settings: null,
  playlists: [],
  queue: null,
  playback: null,
}

const MODES = [
  'consecutive-random',
  'full-shuffle',
  'proportional',
  'sequential-blocks',
  'none',
]

function message(payload) {
  return chrome.runtime.sendMessage(payload)
}

async function refresh() {
  try {
    const reply = await message({ type: 'get-state' })
    if (!reply?.ok) return
    state = reply
    render()
    // Live diagnostic: last tab-routing decision of the worker (visible
    // without the service-worker console).
    try {
      const { diag } = await chrome.storage.session.get('diag')
      el.diagLine.textContent = diag
        ? `${new Date(diag.at).toLocaleTimeString()} · ${diag.note}`
        : ''
    } catch {
      el.diagLine.textContent = ''
    }
  } catch {
    // Worker not ready (just (re)loaded): ignore and retry next tick.
  }
}

// ------------------------------------------------------------------- errors

let addErrorTimer
function showAddError(code) {
  el.addError.textContent = failText(code)
  el.addError.classList.remove('hidden')
  clearTimeout(addErrorTimer)
  addErrorTimer = setTimeout(() => el.addError.classList.add('hidden'), 6000)
}

function showGenError(code) {
  el.genError.textContent = failText(code)
  el.genError.classList.remove('hidden')
}

// ---------------------------------------------------------------- render

// Last queue position the auto-scroll followed (generatedAt + index), so the
// view only follows actual track changes, not every 1s re-render.
let lastAutoScrollKey = null

function render() {
  const { settings, playlists, queue, playback } = state
  if (!settings) return

  // ---------------------------------------------------------- controls row
  const hasQueue = Boolean(queue?.queue?.length)
  el.controls.classList.toggle('hidden', !hasQueue)
  if (hasQueue) {
    const current = queue.queue[queue.index ?? 0]
    el.playBtn.innerHTML = playback?.playing ? PAUSE_ICON : PLAY_ICON
    el.playBtn.title = t(playback?.playing ? 'pause' : 'play')
    el.nowPlaying.textContent = playback?.playing
      ? (current ? `${current.title}` : '')
      : t('nothing_playing')
    el.queuePosition.textContent = t('queue_position', [
      String((queue.index ?? 0) + 1),
      String(queue.queue.length),
    ])
  }

  // ----------------------------------------------------------- queue list
  el.queueSection.classList.toggle('hidden', !hasQueue)
  if (hasQueue) {
    el.queueCount.textContent = t('in_queue', [String(queue.queue.length)])
    renderQueue(queue)
  }

  // ------------------------------------------------------------ playlists
  el.playlistList.replaceChildren()
  el.playlistsEmpty.classList.toggle('hidden', playlists.length > 0)
  el.refreshAllBtn.classList.toggle('hidden', playlists.length === 0)
  const fragment = document.createDocumentFragment()
  for (const playlist of playlists) {
    fragment.appendChild(playlistRow(playlist))
  }
  el.playlistList.appendChild(fragment)

  // ---------------------------------------------------------------- modes
  el.modeList.replaceChildren()
  for (const mode of MODES) {
    el.modeList.appendChild(modeCard(mode, settings.mode))
  }
  el.dedupeToggle.checked = settings.dedupe
  el.reshuffleToggle.checked = settings.reshuffleRounds
}

function playlistRow(playlist) {
  const li = document.createElement('li')
  li.className = 'playlist-row'

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = playlist.active
  checkbox.title = t('toggle_in_mix', [playlist.label])
  checkbox.addEventListener('change', async () => {
    await message({ type: 'set-playlist-active', id: playlist.id, active: checkbox.checked })
    refresh()
  })

  const name = document.createElement('button')
  name.className = 'playlist-name'
  name.textContent = playlist.label
  name.title = playlist.url
  name.addEventListener('click', () => chrome.tabs.create({ url: playlist.url, active: true }))

  const count = document.createElement('span')
  count.className = 'playlist-count'
  count.textContent = `${playlist.availableCount ?? playlist.trackCount}/${playlist.trackCount} ` + t('track_count_suffix')

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'row-btn'
  refreshBtn.textContent = '↻'
  refreshBtn.title = t('refresh_one')
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('busy')
    const reply = await message({ type: 'refresh-playlist', id: playlist.id })
    refreshBtn.classList.remove('busy')
    if (!reply?.ok) showAddError(reply?.code ?? 'unknown')
    refresh()
  })

  const removeBtn = document.createElement('button')
  removeBtn.className = 'row-btn'
  removeBtn.textContent = '✕'
  removeBtn.title = t('remove_one')
  removeBtn.addEventListener('click', async () => {
    await message({ type: 'remove-playlist', id: playlist.id })
    refresh()
  })

  li.append(checkbox, name, count, refreshBtn, removeBtn)
  return li
}

function modeCard(mode, selected) {
  const label = document.createElement('label')
  label.className = 'mode-card' + (mode === selected ? ' selected' : '')

  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'shuffle-mode'
  input.checked = mode === selected
  input.value = mode
  input.addEventListener('change', async () => {
    if (!input.checked) return
    await message({ type: 'set-settings', patch: { mode } })
    refresh()
  })

  const info = document.createElement('span')
  info.className = 'mode-info'
  const title = document.createElement('div')
  title.className = 'mode-label'
  title.textContent = t(`mode_${mode.replace(/-/g, '_')}`)
  const desc = document.createElement('div')
  desc.className = 'mode-desc'
  desc.textContent = t(`mode_${mode.replace(/-/g, '_')}_desc`)
  info.append(title, desc)

  label.append(input, info)
  return label
}

function renderQueue(queue) {
  const playback = state.playback
  const currentIndex = queue.index ?? 0
  el.queueList.replaceChildren()
  let currentBtn = null

  const fragment = document.createDocumentFragment()
  queue.queue.forEach((track, index) => {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.className = 'queue-row' + (index === currentIndex ? ' current' : '')
    if (index === currentIndex) currentBtn = btn

    const idx = document.createElement('span')
    idx.className = 'queue-index'
    idx.textContent = String(index + 1)

    const img = document.createElement('img')
    img.className = 'queue-thumb'
    img.loading = 'lazy'
    img.src = track.thumbnail
    img.alt = ''

    const trackBox = document.createElement('span')
    trackBox.className = 'queue-track'
    const title = document.createElement('span')
    title.className = 'queue-title'
    title.textContent = track.title
    const meta = document.createElement('span')
    meta.className = 'queue-meta'
    meta.textContent = track.channel
    trackBox.append(title, meta)

    const duration = document.createElement('span')
    duration.className = 'queue-duration'
    duration.textContent = formatDuration(track.durationSec)

    btn.append(idx, img, trackBox, duration)

    if (!track.available) {
      const badge = document.createElement('span')
      badge.className = 'queue-skip-badge'
      badge.textContent = t('unavailable_badge')
      btn.append(badge)
      btn.style.opacity = '0.45'
      btn.disabled = true
    } else {
      btn.addEventListener('click', async () => {
        await message({ type: 'jump-to', index })
        refresh()
      })
    }

    li.appendChild(btn)
    fragment.appendChild(li)
  })
  el.queueList.appendChild(fragment)

  // Auto-scroll to the playback position, but ONLY when it actually moved or
  // the queue was regenerated: the popup re-renders on the 1s poll and must
  // never fight the user's own scrolling. Opening the popup on song 140 puts
  // that song in view immediately, and every track change keeps it visible.
  const autoScrollKey = `${queue.generatedAt}#${currentIndex}`
  if (currentBtn && autoScrollKey !== lastAutoScrollKey) {
    lastAutoScrollKey = autoScrollKey
    currentBtn.scrollIntoView({ block: 'center' })
  }

  if (currentIndex + 1 === queue.queue.length) {
    el.statusLine.textContent = t('queue_finished')
  } else {
    el.statusLine.textContent = ''
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ---------------------------------------------------------------- actions

el.urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.addBtn.click()
})

el.addBtn.addEventListener('click', async () => {
  const url = el.urlInput.value.trim()
  if (!url) {
    showAddError('empty')
    return
  }
  el.addBtn.disabled = true
  el.addBtn.textContent = '…'
  try {
    const reply = await message({ type: 'add-playlist', url })
    if (!reply?.ok) {
      showAddError(reply?.code ?? 'unknown')
    } else {
      el.urlInput.value = ''
      el.addError.classList.add('hidden')
      await refresh()
    }
  } finally {
    el.addBtn.disabled = false
    el.addBtn.textContent = t('add_btn')
  }
})

el.refreshAllBtn.addEventListener('click', async () => {
  el.refreshAllBtn.disabled = true
  el.refreshAllBtn.textContent = '…'
  try {
    for (const playlist of state.playlists) {
      const reply = await message({ type: 'refresh-playlist', id: playlist.id })
      if (!reply?.ok) {
        showAddError(reply?.code ?? 'unknown')
        break
      }
    }
    await refresh()
  } finally {
    el.refreshAllBtn.disabled = false
    el.refreshAllBtn.textContent = t('refresh_all')
  }
})

el.dedupeToggle.addEventListener('change', async () => {
  await message({ type: 'set-settings', patch: { dedupe: el.dedupeToggle.checked } })
  refresh()
})

el.reshuffleToggle.addEventListener('change', async () => {
  await message({ type: 'set-settings', patch: { reshuffleRounds: el.reshuffleToggle.checked } })
  refresh()
})

el.mixBtn.addEventListener('click', async () => {
  el.genError.classList.add('hidden')
  const reply = await message({ type: 'shuffle', andPlay: false })
  if (!reply?.ok) showGenError(reply?.code ?? 'unknown')
  refresh()
})

el.mixPlayBtn.addEventListener('click', async () => {
  el.genError.classList.add('hidden')
  el.mixPlayBtn.disabled = true
  try {
    const reply = await message({ type: 'shuffle', andPlay: true })
    if (!reply?.ok) showGenError(reply?.code ?? 'unknown')
    refresh()
  } finally {
    el.mixPlayBtn.disabled = false
  }
})

el.playBtn.addEventListener('click', async () => {
  const playing = !(state.playback?.playing ?? false)
  const reply = await message({ type: 'set-playing', value: playing })
  if (!reply?.ok) showGenError(reply?.code ?? 'unknown')
  refresh()
})

el.nextBtn.addEventListener('click', async () => {
  await message({ type: 'next' })
  refresh()
})

el.prevBtn.addEventListener('click', async () => {
  await message({ type: 'prev' })
  refresh()
})

el.optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

// ------------------------------------------------------------------- boot

applyStaticI18n()
refresh()
// Poll while open — MV3 workers deliver no push events for storage changes.
setInterval(refresh, 1000)
