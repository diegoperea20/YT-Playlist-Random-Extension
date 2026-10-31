import { shuffle } from './fisherYates.js'
import { activePools, buildPools } from './pools.js'
import { DEFAULT_SHUFFLE_OPTIONS } from '../types.js'

/**
 * The main mode: pick a random starting playlist, then alternate between them taking
 * one random unused track per turn. Exhausted playlists are skipped.
 *
 * `A=[s1,s2,s3]`, `B=[s1b,s2b,s3b]` -> `s1, s3b, s2, s1b, s3, s2b`
 */
export function consecutiveRandom(playlists, options = DEFAULT_SHUFFLE_OPTIONS) {
  const pools = activePools(buildPools(playlists, options))
  if (pools.length === 0) return []

  let order = shuffle(pools)
  // Tracks left to emit in the current round; reaching zero starts a new round.
  let roundLeft = order.length
  let turn = 0

  const result = []

  while (order.some((pool) => pool.length > 0)) {
    const pool = order[turn % order.length]
    turn++

    if (pool.length === 0) continue

    result.push(pool.shift())
    roundLeft--

    if (roundLeft === 0) {
      // A new round begins: optionally reshuffle the turn order for more variety.
      if (options.reshuffleRounds) {
        order = shuffle(order)
        turn = 0
      }
      roundLeft = order.filter((item) => item.length > 0).length
    }
  }

  return result
}
