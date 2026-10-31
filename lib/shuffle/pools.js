import { shuffle } from './fisherYates.js'
import { DEFAULT_SHUFFLE_OPTIONS } from '../types.js'

/**
 * Build one shuffled pool per playlist.
 * Unavailable tracks are always dropped; cross-playlist duplicates are removed
 * up-front when `dedupe` is enabled, which keeps every algorithm simple.
 */
export function buildPools(playlists, options = DEFAULT_SHUFFLE_OPTIONS, shufflePools = true) {
  const seen = new Set()

  return playlists.map((playlist) => {
    const playable = playlist.tracks.filter((track) => track.available)

    if (!options.dedupe) return shufflePools ? shuffle(playable) : playable

    const unique = playable.filter((track) => {
      if (seen.has(track.id)) return false
      seen.add(track.id)
      return true
    })

    return shufflePools ? shuffle(unique) : unique
  })
}

/** Pools that have at least one track left. */
export function activePools(pools) {
  return pools.filter((pool) => pool.length > 0)
}
