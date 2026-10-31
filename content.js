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
        sendResponse({ ok: true })
        return false

      case 'resume-video':
        resumeVideo()
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
    const videoId = new URLSearchParams(location.search).get('v')
    if (!videoId || location.pathname !== '/watch') return
    chrome.runtime.sendMessage({ type: 'yt-navigation', videoId }).catch(() => {})
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
    })
    .catch(() => {})
})()
