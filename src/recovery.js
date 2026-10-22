/**
 * Recovery ladder for a single step.
 * Tracks stall count and decides the next recovery action.
 */
export class RecoveryLadder {
  constructor(maxRecoveryWindowMinutes) {
    this.maxRecoveryWindowMs = maxRecoveryWindowMinutes * 60 * 1000
    this.reset()
  }

  reset() {
    this.stallCount = 0
    this.firstStallTime = null
    this.stepStartTime = Date.now()
  }

  /**
   * Record a stall and return the recovery action.
   * @returns {{ action: 'nudge' | 'nudge_with_log' | 'skip' | 'blocked', nudgeText?: string }}
   */
  recordStall(nudgeText) {
    const now = Date.now()
    if (this.firstStallTime === null) {
      this.firstStallTime = now
    }

    // Check if we're outside the recovery window
    if (now - this.firstStallTime > this.maxRecoveryWindowMs) {
      return { action: 'blocked' }
    }

    this.stallCount++

    switch (this.stallCount) {
      case 1:
        return { action: 'nudge', nudgeText }
      case 2:
        return { action: 'nudge_with_log', nudgeText }
      case 3:
        return { action: 'skip' }
      default:
        return { action: 'blocked' }
    }
  }

  /**
   * Record a successful recovery (events resumed).
   */
  recordRecovery() {
    this.stallCount = 0
    this.firstStallTime = null
  }
}

/**
 * Error backoff tracker.
 */
export class ErrorBackoff {
  constructor(maxRetries) {
    this.maxRetries = maxRetries
    this.reset()
  }

  reset() {
    this.retryCount = 0
  }

  /**
   * Get the next backoff delay in milliseconds, or null if max retries reached.
   * Backoff sequence: 5, 10, 20, 40, 60, 60, 60, ... seconds
   */
  nextDelay() {
    if (this.retryCount >= this.maxRetries) return null
    const delays = [5000, 10000, 20000, 40000, 60000]
    const delay = delays[Math.min(this.retryCount, delays.length - 1)]
    this.retryCount++
    return delay
  }
}
