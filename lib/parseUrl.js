const VALID_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'music.youtube.com',
  'm.youtube.com',
  'youtu.be',
]

/** Ids that the public Data API cannot read: auto-generated mixes and "Liked music". */
export const UNSUPPORTED_PLAYLIST_IDS = ['LL', 'WL']

/**
 * Extract the `list` id from a YouTube / YouTube Music URL.
 * Also returns the `v` id when the URL points to a specific video.
 * Returns `{ ok:true, playlistId, videoId }` or `{ ok:false, reason }` where
 * reason is one of: empty | invalid-url | unsupported-host | missing-list-param |
 * not-a-playlist | auto-mix | liked-music.
 */
export function parsePlaylistUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, reason: 'empty' }

  let url
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }

  if (!VALID_HOSTS.includes(url.hostname)) {
    return { ok: false, reason: 'unsupported-host' }
  }

  const playlistId = url.searchParams.get('list')
  const videoId = url.searchParams.get('v')

  if (!playlistId) {
    if (url.pathname.startsWith('/playlist')) {
      return { ok: false, reason: 'missing-list-param' }
    }
    return { ok: false, reason: 'not-a-playlist' }
  }

  if (playlistId.startsWith('RD')) {
    return { ok: false, reason: 'auto-mix' }
  }

  if (UNSUPPORTED_PLAYLIST_IDS.includes(playlistId)) {
    return { ok: false, reason: 'liked-music' }
  }

  return { ok: true, playlistId, videoId }
}

/** Canonical, shareable URL for a playlist. */
export function playlistUrl(playlistId) {
  return `https://www.youtube.com/playlist?list=${playlistId}`
}
