import { consecutiveRandom } from './consecutiveRandom.js'
import { fullShuffle } from './fullShuffle.js'
import { proportional } from './proportional.js'
import { sequentialBlocks } from './sequentialBlocks.js'

/** Registry of every available randomization mode. */
const SHUFFLE_ENGINES = {
  'consecutive-random': consecutiveRandom,
  'full-shuffle': fullShuffle,
  proportional,
  'sequential-blocks': sequentialBlocks,
  // With no randomness the tracks keep their playlist order; only dedupe and
  // the availability filter apply.
  none: (playlists, options) => sequentialBlocks(playlists, options, false),
}

/** Build the queue for the given mode. */
export function generateQueue(mode, playlists, options) {
  const engine = SHUFFLE_ENGINES[mode] ?? consecutiveRandom
  return engine(playlists, options)
}

export { SHUFFLE_ENGINES }
