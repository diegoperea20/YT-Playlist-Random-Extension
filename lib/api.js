import { YoutubeApiError } from './errors.js'
import { parseIsoDuration } from './time.js'

const API_BASE = 'https://www.googleapis.com/youtube/v3'
const PAGE_SIZE = 50

/** Map a Google API error payload onto our error codes. */
function toApiError(status, reason) {
  if (status === 404) {
    return new YoutubeApiError('playlist-not-found', status)
  }
  if (reason === 'playlistItemsNotAccessible' || reason === 'playlistNotAccessible') {
    return new YoutubeApiError('playlist-not-accessible', status)
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || status === 429) {
    return new YoutubeApiError('quota-exceeded', status)
  }
  if (status === 403) {
    return new YoutubeApiError('forbidden', status)
  }
  return new YoutubeApiError('unknown', status)
}

export function requireApiKey(settingsApiKey, bundledKey) {
  const key = String(settingsApiKey || '').trim() || String(bundledKey || '').trim()
  if (!key) throw new YoutubeApiError('missing-api-key')
  return key
}

async function requestYouTube(path, params, apiKey, fetchImpl, signal) {
  const url = new URL(`${API_BASE}/${path}`)
  url.searchParams.set('key', apiKey)
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value)
  }

  const fetchFn = fetchImpl || fetch
  const response = await fetchFn(url, { signal })
  if (!response.ok) {
    let reason
    try {
      const body = await response.json()
      reason = body?.error?.errors?.[0]?.reason
    } catch {
      // Non-JSON error bodies are ignored; the status code is enough.
    }
    throw toApiError(response.status, reason)
  }

  return response.json()
}

/** Fetch every item of a playlist, following `nextPageToken`. */
export async function fetchPlaylistItems(playlistId, apiKey, fetchImpl, signal) {
  const items = []
  let pageToken

  do {
    const page = await requestYouTube(
      'playlistItems',
      {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: String(PAGE_SIZE),
        ...(pageToken ? { pageToken } : {}),
      },
      apiKey,
      fetchImpl,
      signal,
    )
    items.push(...(page.items ?? []))
    pageToken = page.nextPageToken ?? undefined
  } while (pageToken)

  return items
}

/** The playlist title itself costs 1 unit and gives a friendly default label. */
export async function fetchPlaylistTitle(playlistId, apiKey, fetchImpl, signal) {
  try {
    const page = await requestYouTube(
      'playlists',
      { part: 'snippet', id: playlistId, maxResults: '1' },
      apiKey,
      fetchImpl,
      signal,
    )
    return page.items?.[0]?.snippet?.title ?? null
  } catch {
    // A missing title must never break the whole load.
    return null
  }
}

/** Durations cost 1 unit per call, so ids are batched 50 at a time. */
export async function fetchDurations(videoIds, apiKey, fetchImpl, signal) {
  const durations = new Map()
  const uniqueIds = [...new Set(videoIds)]

  for (let i = 0; i < uniqueIds.length; i += PAGE_SIZE) {
    const batch = uniqueIds.slice(i, i + PAGE_SIZE)
    const response = await requestYouTube(
      'videos',
      { part: 'contentDetails', id: batch.join(',') },
      apiKey,
      fetchImpl,
      signal,
    )
    for (const item of response.items ?? []) {
      const duration = item.contentDetails?.duration
      if (item.id && duration) {
        durations.set(item.id, parseIsoDuration(duration))
      }
    }
  }

  return durations
}

/** Pick the best available thumbnail, falling back to the generated `mqdefault` one. */
function bestThumbnail(thumbnails, videoId) {
  return (
    thumbnails?.high?.url ??
    thumbnails?.medium?.url ??
    thumbnails?.default?.url ??
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  )
}

/** Convert raw API items into tracks, dropping entries without a usable videoId. */
export function itemsToTracks(playlistId, items, durations, fallbacks) {
  const tracks = []
  const seen = new Set()

  for (const item of items) {
    const videoId = item.contentDetails?.videoId
    // Deleted, private or region-blocked entries come back without videoId.
    if (!videoId || seen.has(videoId)) continue
    seen.add(videoId)

    tracks.push({
      id: videoId,
      title: item.snippet?.title ?? fallbacks.untitled,
      channel: item.snippet?.channelTitle ?? fallbacks.unknownChannel,
      thumbnail: bestThumbnail(item.snippet?.thumbnails, videoId),
      durationSec: durations.get(videoId) ?? 0,
      playlistId,
      available: true,
    })
  }

  return tracks
}

/**
 * Full pipeline: items + durations + (1 more unit for) the playlist title.
 * Mirrors `loadPlaylistTracksServer` but calls Google directly from the worker.
 */
export async function loadPlaylistTracks(
  playlistId,
  apiKey,
  fallbacks,
  fetchImpl,
  signal,
) {
  const items = await fetchPlaylistItems(playlistId, apiKey, fetchImpl, signal)
  const videoIds = items
    .map((item) => item.contentDetails?.videoId)
    .filter((id) => Boolean(id))

  const durations = await fetchDurations(videoIds, apiKey, fetchImpl, signal)
  const tracks = itemsToTracks(playlistId, items, durations, fallbacks)

  const label = await fetchPlaylistTitle(playlistId, apiKey, fetchImpl, signal)
  return { tracks, label }
}
