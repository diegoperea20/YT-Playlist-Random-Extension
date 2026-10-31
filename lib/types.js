/** The five randomization modes, same ids as the web app (`src/types.ts`). */
export const SHUFFLE_MODES = [
  'consecutive-random',
  'full-shuffle',
  'proportional',
  'sequential-blocks',
  'none',
]

export const DEFAULT_SHUFFLE_OPTIONS = {
  dedupe: true,
  reshuffleRounds: false,
}

export const DEFAULT_SETTINGS = {
  mode: 'consecutive-random',
  dedupe: true,
  reshuffleRounds: false,
  site: 'youtube', // 'youtube' | 'music'
  apiKey: '', // empty = use BUNDLED_API_KEY
}

/** A single playable item coming from a playlist.
 *  { id, title, channel, thumbnail, durationSec, playlistId, available } */
