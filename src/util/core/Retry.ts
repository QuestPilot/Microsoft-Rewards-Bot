import type { ConfigRetryPolicy } from "../../interface/Config";
import { secureRandom } from "../security/SecureRandom";
import { Util } from "./Utils";

type NumericPolicy = {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: number;
};

export type Retryable<T> = () => Promise<T>;

/**
 * Exponential backoff retry mechanism with jitter
 * IMPROVED: Added comprehensive documentation
 */
export class Retry {
  private policy: NumericPolicy;

  /**
   * Create a retry handler with exponential backoff
   * @param policy - Retry policy configuration (optional)
   * @example new Retry({ maxAttempts: 5, baseDelay: 2000 })
   */
  constructor(policy?: ConfigRetryPolicy) {
    const def: NumericPolicy = {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      multiplier: 2,
      jitter: 0.2,
    };
    const merged: ConfigRetryPolicy = { ...(policy || {}) };
    // normalize string durations
    const util = new Util();
    const parse = (v: number | string) => {
      if (typeof v === "number") return v;
      try {
        return util.stringToMs(String(v));
      } catch {
        /* Invalid time string: fall back to default */ return def.baseDelay;
      }
    };
    this.policy = {
      maxAttempts: (merged.maxAttempts as number) ?? def.maxAttempts,
      baseDelay: parse(merged.baseDelay ?? def.baseDelay),
      maxDelay: parse(merged.maxDelay ?? def.maxDelay),
      multiplier: (merged.multiplier as number) ?? def.multiplier,
      jitter: (merged.jitter as number) ?? def.jitter,
    };
  }

  /**
   * Execute a function with exponential backoff retry logic
   * @param fn - Async function to retry
   * @param isRetryable - Optional predicate to determine if error is retryable
   * @returns Result of the function
   * @throws {Error} Last error if all attempts fail
   * @example await retry.run(() => fetchAPI(), (err) => err.statusCode !== 404)
   */
  async run<T>(
    fn: Retryable<T>,
    isRetryable?: (e: unknown) => boolean,
  ): Promise<T> {
    let attempt = 0;
    let delay = this.policy.baseDelay;
    let lastErr: unknown;

    while (attempt < this.policy.maxAttempts) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        attempt += 1;
        const retry = isRetryable ? isRetryable(e) : true;
        if (!retry || attempt >= this.policy.maxAttempts) break;
        // Apply jitter: vary delay by ±jitter% (e.g., jitter=0.2 means ±20%)
        const jitter = 1 + (secureRandom() * 2 - 1) * this.policy.jitter;
        const sleep = Math.min(
          this.policy.maxDelay,
          Math.max(0, Math.floor(delay * jitter)),
        );
        await new Promise((r) => setTimeout(r, sleep));
        delay = Math.min(
          this.policy.maxDelay,
          Math.floor(delay * (this.policy.multiplier || 2)),
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
