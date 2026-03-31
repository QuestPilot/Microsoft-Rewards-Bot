export class MobileRetryTracker {
  private attempts = 0
  private readonly maxRetries: number

  constructor(maxRetries: number) {
    const normalized = Number.isFinite(maxRetries) ? Math.floor(maxRetries) : 0
    this.maxRetries = Math.max(0, normalized)
  }

  /**
   * Register an incomplete mobile search attempt.
   * @returns true when another retry should be attempted, false when the retry budget is exhausted.
   */
  registerFailure(): boolean {
    this.attempts += 1
    return this.attempts <= this.maxRetries
  }

  hasExceeded(): boolean {
    return this.attempts > this.maxRetries
  }

  getAttemptCount(): number {
    return this.attempts
  }
}
