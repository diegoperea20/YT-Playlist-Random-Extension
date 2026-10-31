/**
 * Error carrying a code instead of a message, so any UI (es/en) can render a
 * precise, localized, actionable string. `message` is the code itself.
 */
export class YoutubeApiError extends Error {
  constructor(code, status = undefined) {
    super(code)
    this.name = 'YoutubeApiError'
    this.code = code
    this.status = status
  }
}

export function codeOf(error) {
  if (error instanceof YoutubeApiError) return error.code
  return 'unknown'
}
