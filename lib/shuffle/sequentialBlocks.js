import { buildPools } from './pools.js'
import { DEFAULT_SHUFFLE_OPTIONS } from '../types.js'

/**
 * Playlist by playlist, each one shuffled internally, in the original playlist order.
 * With no randomness (`none`), pools keep the playlist's original track order
 * ("concatenate playlists in their original order") dedupe/available still filter.
 */
export function sequentialBlocks(playlists, options = DEFAULT_SHUFFLE_OPTIONS, shufflePools = true) {
  return buildPools(playlists, options, shufflePools).flat()
}
