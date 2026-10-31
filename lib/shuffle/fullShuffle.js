import { shuffle } from './fisherYates.js'
import { buildPools } from './pools.js'
import { DEFAULT_SHUFFLE_OPTIONS } from '../types.js'

/** Every track from every playlist mixed into a single pool. */
export function fullShuffle(playlists, options = DEFAULT_SHUFFLE_OPTIONS) {
  return shuffle(buildPools(playlists, options).flat())
}
