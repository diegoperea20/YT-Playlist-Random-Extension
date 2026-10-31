/** In-place Fisher-Yates shuffle. Returns a new array, never mutates the input. */
export function shuffle(array) {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Pick one random element, or `undefined` for an empty array. */
export function randomPick(array) {
  if (array.length === 0) return undefined
  return array[Math.floor(Math.random() * array.length)]
}
