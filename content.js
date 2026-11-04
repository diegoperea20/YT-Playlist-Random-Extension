/**
 * YT Playlist Random — content script (navegación nativa).
 *
 * The extension plays the shuffled queue with YouTube's OWN player on
 * www.youtube.com / music.youtube.com pages. The service worker simply
 * navigates the tab to the next `watch?v=<id>`; this script's job:
 *  1. Make sure the page actually starts playing (autoplay blockers,
 *     large play button, muted fallback).
 *  2. Pause IMMEDIATELY on `ended` so YouTube's native autoplay never
 *     takes over, and tell the worker to load the next track.
 *  3. Detect only REAL unavailability (player error or a track stuck
 *     for ~12s) so a slow-buffering video is never skipped early.
 */
(() => {
  if (window.__yprContentLoaded) return
  window.__yprContentLoaded = true

  const isMusic = location.hostname === 'music.youtube.com'
  let currentTrackedId = null
  const reportedErrors = new Set()

  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'pause-video':
        pauseVideo()
        // A worker command means it is actively managing us again: re-sync
        // the media keys (the ownership verdict may have just changed).
        publishMediaSessionActions()
        sendResponse({ ok: true })
        return false

      case 'resume-video':
        resumeVideo()
        publishMediaSessionActions()
        // Give the player a moment, then report what actually happened.
        setTimeout(() => {
          const video = document.querySelector('video')
          if (video?.paused) ensurePagePlaying(currentVideoIdNow(), true)
        }, 1500)
        sendResponse({ ok: true })
        return false

      default:
        return false
    }
  })

  // ---------------------------------------------------------------- helpers

  function currentVideoIdNow() {
    try {
      const data = document.getElementById('movie_player')?.getVideoData?.()
      if (data?.video_id) return data.video_id
    } catch {
      // introspection is best-effort only
    }
    const v = new URLSearchParams(location.search).get('v')
    return v ?? location.pathname.split('/').pop()
  }

  function pauseVideo() {
    try {
      document.getElementById('movie_player')?.pauseVideo?.()
    } catch {
      // noop
    }
    const video = document.querySelector('video')
    if (video && !video.paused) video.pause()
  }

  function resumeVideo() {
    try {
      document.getElementById('movie_player')?.playVideo?.()
    } catch {
      // noop
    }
    const video = document.querySelector('video')
    if (video) {
      const p = video.play()
      p?.catch?.(() => {
        /* blocked; the kicker below retries */
      })
    }
  }

  function clickMainPlayButton() {
    const selectors = [
      '.ytp-play-button.ytp-large-play-button',
      '.ytp-large-play-button',
      '.ytmusic-player-play-button',
      'button[aria-label*="Play" i]',
      'button[title*="Play" i]',
    ]
    for (const selector of selectors) {
      const btn = document.querySelector(selector)
      if (btn) {
        btn.click()
        return
      }
    }
  }

  // ------------------------------------------------------- kick-start playback

  /**
   * The watch page usually autoplays by itself, but browser autoplay policies can
   * block it: retry by nudging the player, clicking the big play button and
   * falling back to muted play, which browsers always allow.
   */
  function ensurePagePlaying(videoId, soft = false) {
    if (!videoId || currentVideoIdNow() !== videoId) return // wrong page, nothing to do

    const video = document.querySelector('video')
    if (video && (video.currentTime > 0.2 || (!video.paused && video.readyState >= 2))) return

    try {
      document.getElementById('movie_player')?.playVideo?.()
    } catch { /* noop */ }
    if (video) {
      const p = video.play()
      p?.catch?.(() => { /* blocked */ })
    }
    if (video?.paused) clickMainPlayButton()

    // Muted autoplay is always allowed; restore the sound as soon as it starts.
    if (video?.paused && soft) {
      try {
        video.muted = true
        video
          .play()
          .then(() => {
            const unmute = () => {
              video.muted = false
              video.removeEventListener('playing', unmute)
            }
            video.addEventListener('playing', unmute, { once: true })
            setTimeout(unmute, 2500) // also covers the settled-but-not-fired case
          })
          .catch(() => {
            video.muted = false
          })
      } catch { /* noop */ }
    }
  }

  // ---------------------------------------------------- media session (⏭/⏮)

  /**
   * Chrome/Brave media keys and the browser's media hub (Previous / Next /
   * Play / Pause) drive the SAME commands the popup sends. Chrome may route a
   * media key to the session of whichever YouTube tab the user is LOOKING at,
   * not the one playing the queue — so the binding is level-based:
   *
   *   full — this tab IS the playback tab, on the queue's current track:
   *          next/prev/play/pause/stop all drive the queue.
   *   next — the queue is playing elsewhere but this tab is idle/not the
   *          playback tab: ONLY next/prev advance the queue (the hub's ⏭/⏮
   *          must reach the ONE playing tab, never spawn a second one), and
   *          play/pause stay native so the user's own video is never hijacked.
   *   off  — no active queue (or the user is actively watching a video here):
   *          everything stays native.
   */
  let mediaLevel = 'off' // 'full' | 'next' | 'off'
  let lastOwned = false
  let lastQueuePlaying = false
  const MEDIA_ACTIONS = ['nexttrack', 'previoustrack', 'play', 'pause', 'stop']

  function sendQueueMessage(type, extra = {}) {
    chrome.runtime.sendMessage({ type, ...extra }).catch(() => {})
  }

  /** Is the user actually watching something in this tab right now? */
  function isTabBusyPlaying() {
    const video = document.querySelector('video')
    return Boolean(video && !video.paused && video.readyState >= 2)
  }

  function effectiveMediaLevel() {
    if (lastOwned) return 'full'
    if (lastQueuePlaying && !isTabBusyPlaying()) return 'next'
    return 'off'
  }

  function setMediaLevel(level) {
    if (!('mediaSession' in navigator)) return
    if (level === 'off' && mediaLevel === 'off') return // already idle, nothing to release
    mediaLevel = level
    try {
      if (level === 'full') {
        navigator.mediaSession.setActionHandler('nexttrack', () => sendQueueMessage('next'))
        navigator.mediaSession.setActionHandler('previoustrack', () => sendQueueMessage('prev'))
        navigator.mediaSession.setActionHandler('play', () => sendQueueMessage('set-playing', { value: true }))
        navigator.mediaSession.setActionHandler('pause', () => sendQueueMessage('set-playing', { value: false }))
        navigator.mediaSession.setActionHandler('stop', () => sendQueueMessage('set-playing', { value: false }))
      } else if (level === 'next') {
        navigator.mediaSession.setActionHandler('nexttrack', () => sendQueueMessage('next'))
        navigator.mediaSession.setActionHandler('previoustrack', () => sendQueueMessage('prev'))
        // Avoid stale full-bindings: play/pause must not affect the queue here.
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
        navigator.mediaSession.setActionHandler('stop', null)
      } else {
        for (const action of MEDIA_ACTIONS) {
          navigator.mediaSession.setActionHandler(action, null)
        }
      }
    } catch (error) {
      console.warn('[YPR] Media Session error:', error)
    }
  }

  function publishMediaSessionActions() {
    if (!('mediaSession' in navigator)) return
    chrome.runtime
      .sendMessage({ type: 'get-media-session' })
      .then((reply) => {
        lastOwned = Boolean(reply?.owned)
        lastQueuePlaying = Boolean(reply?.queuePlaying)
        setMediaLevel(effectiveMediaLevel())
      })
      .catch(() => {})
  }

  /** Apply an ownership verdict that did not come from `get-media-session`. */
  function setOwnedVerdict(value) {
    lastOwned = Boolean(value)
    setMediaLevel(effectiveMediaLevel())
  }

  /**
   * YouTube re-registers its own media handlers at unpredictable moments
   * (metadata load, SPA refresh...) and the LAST registration wins. Binding
   * ours exactly once per page is not enough — that is why the next-key died
   * after a track or two. Re-assert (and possibly upgrade/downgrade) on a
   * short local interval: cheap, and it never wakes the service worker.
   */
  setInterval(() => {
    setMediaLevel(effectiveMediaLevel())
  }, 2000)

  // ------------------------------------------------------------------ ended

  function attachEnded(video) {
    if (!video || video.dataset.__yprEnded) return
    video.dataset.__yprEnded = '1'

    video.addEventListener('ended', (event) => {
      const videoEl = event.target
      const videoId = currentVideoIdNow()
      if (!videoId) return
      // Pause right away: YouTube's own autoplay must not take over the tab.
      try {
        videoEl.pause()
      } catch { /* noop */ }
      chrome.runtime.sendMessage({ type: 'track-ended', videoId }).catch(() => {})
    })

    video.addEventListener('play', () => {
      chrome.runtime
        .sendMessage({ type: 'play-state', playing: true, videoId: currentVideoIdNow() })
        .catch(() => {})
      // YouTube may have re-registered its own media handlers on this page;
      // re-assert ours whenever playback actually starts.
      publishMediaSessionActions()
    })

    video.addEventListener('pause', () => {
      // Our own pause/next commands pause too — only signal a *user interruption*.
      if (video.currentTime > 0 && !video.ended) {
        chrome.runtime
          .sendMessage({ type: 'play-state', playing: false, videoId: currentVideoIdNow() })
          .catch(() => {})
      }
    })
  }

  function attachEndedToAll() {
    document.querySelectorAll('video').forEach(attachEnded)
  }

  // Watch DOM churn (SPA navigations) so we never lose the ended listener.
  const observer = new MutationObserver(() => attachEndedToAll())
  Promise.resolve().then(() => {
    observer.observe(document.body, { childList: true, subtree: true })
    attachEndedToAll()
  })

  // ---------------------------------------------------- anti-native-autoplay

  function disableNativeAutoplayToggle() {
    if (sessionStorage.getItem('__yprAutoplayOff') === '1') return
    const selectors = [
      '.ytd-autoplay-toggle[aria-pressed="true"]',
      '#toggle.ytd-autoplay-renderer[aria-pressed="true"]',
      '.ytmusic-autoplay-toggle[aria-pressed="true"]',
    ]
    for (const selector of selectors) {
      const toggle = document.querySelector(selector)
      if (toggle) {
        toggle.click()
        sessionStorage.setItem('__yprAutoplayOff', '1')
        return
      }
    }
  }

  // ------------------------------------------------------- real unavailability

  /**
   * Verify the navigated track ACTUALLY plays. Only a player error (100/101/150,
   * region-locked, removed) or >12s dead-and-paused counts as unavailable, so a
   * buffering video is never mistaken for a broken one.
   */
  function watchForUnavailable(videoId) {
    if (!videoId || reportedErrors.has(videoId)) return
    reportedErrors.add(videoId)
    currentTrackedId = videoId
    const started = Date.now()

    const tick = () => {
      if (currentTrackedId !== videoId || currentVideoIdNow() !== videoId) return // moved on
      if (Date.now() - started > 14000) return // watching is over

      let playerError = null
      try {
        playerError = document.getElementById('movie_player')?.getPlayerError?.() || null
      } catch { /* noop */ }
      const errorEl = document.querySelector('.ytp-error')
      if (playerError || errorEl) {
        chrome.runtime.sendMessage({ type: 'player-error', videoId }).catch(() => {})
        return
      }

      const video = document.querySelector('video')
      if (!video) {
        if (Date.now() - started > 10000) {
          // No video element after 10s on a watch page = genuinely broken.
          chrome.runtime.sendMessage({ type: 'player-error', videoId }).catch(() => {})
          return
        }
        setTimeout(tick, 1000)
        return
      }

      const playing = video.currentTime > 0.2 || (!video.paused && video.readyState >= 2)
      if (playing) return // all good

      // Still paused at ~0 after several seconds: nudge once more, then decide.
      if (Date.now() - started > 8000 && video.currentTime < 0.1 && video.paused) {
        ensurePagePlaying(videoId, true)
        if (Date.now() - started > 13000 && video.currentTime < 0.1 && video.paused) {
          // Dead for 13s: treat as unavailable so the queue keeps flowing.
          chrome.runtime.sendMessage({ type: 'player-error', videoId }).catch(() => {})
          return
        }
      }
      setTimeout(tick, 1000)
    }

    setTimeout(tick, 2500) // first check after the page settled
  }

  // ------------------------------------------------------------- page hooks

  function onPageReady() {
    attachEndedToAll()
    disableNativeAutoplayToggle()
    publishMediaSessionActions()
    const videoId = new URLSearchParams(location.search).get('v')
    if (!videoId || location.pathname !== '/watch') return
    chrome.runtime
      .sendMessage({ type: 'yt-navigation', videoId })
      .then((reply) => {
        // The page landed exactly where the queue expects it: ours. Otherwise
        // (native autoplay / manual navigation) downgrade accordingly.
        if (reply && 'owned' in reply) setOwnedVerdict(reply.owned)
      })
      .catch(() => {})
    // Give every fresh watch page up to a few nudges to start on its own.
    ensurePagePlaying(videoId)
    setTimeout(() => ensurePagePlaying(videoId, true), 1500)
    setTimeout(() => ensurePagePlaying(videoId, true), 4000)
    watchForUnavailable(videoId)
  }

  window.addEventListener('yt-navigate-finish', onPageReady)
  onPageReady()

  // ------------------------------------------------------------------- ready

  chrome.runtime
    .sendMessage({ type: 'content-ready' })
    .then((reply) => {
      if (reply?.kick && reply.videoId && currentVideoIdNow() === reply.videoId) {
        ensurePagePlaying(reply.videoId, true)
      }
      // The background just settled this tab's ownership state; ask for media
      // binding again (a fresh playback tab raced against the earlier check).
      publishMediaSessionActions()
    })
    .catch(() => {})
})()
