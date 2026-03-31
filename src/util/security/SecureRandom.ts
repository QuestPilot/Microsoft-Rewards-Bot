/**
 * Cryptographically Secure Random Number Generator
 *
 * CRITICAL: Math.random() is predictable and can be fingerprinted by Microsoft
 * This module uses crypto.getRandomValues() for unpredictable randomness
 *
 * DETECTION RISK: Math.random() produces patterns that bot detection can identify:
 * - V8 engine uses xorshift128+ algorithm with predictable sequences
 * - Given enough samples, the seed can be reconstructed
 * - Microsoft likely monitors Math.random() distribution patterns
 *
 * SOLUTION: crypto.getRandomValues() uses OS entropy sources (hardware RNG)
 * making it impossible to predict future values from past observations
 */

import { randomBytes } from "crypto";

/**
 * Generate cryptographically secure random float [0, 1)
 * Drop-in replacement for Math.random()
 *
 * @returns Random float between 0 (inclusive) and 1 (exclusive)
 * @example
 * const r = secureRandom() // 0.7234821...
 */
export function secureRandom(): number {
  // Use 4 bytes (32 bits) for sufficient precision
  const bytes = randomBytes(4);
  // Convert to unsigned 32-bit integer
  const uint32 = bytes.readUInt32BE(0);
  // Normalize to [0, 1) range
  return uint32 / 0x100000000;
}

/**
 * Generate cryptographically secure random integer in range [min, max]
 *
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random integer in range
 * @example
 * const delay = secureRandomInt(100, 500) // Random 100-500
 */
export function secureRandomInt(min: number, max: number): number {
  if (min > max) {
    [min, max] = [max, min];
  }
  const range = max - min + 1;
  return Math.floor(secureRandom() * range) + min;
}

/**
 * Generate cryptographically secure random float in range [min, max]
 *
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random float in range
 * @example
 * const multiplier = secureRandomFloat(0.8, 1.2) // Random 0.8-1.2
 */
export function secureRandomFloat(min: number, max: number): number {
  if (min > max) {
    [min, max] = [max, min];
  }
  return secureRandom() * (max - min) + min;
}

/**
 * Generate cryptographically secure boolean with probability
 *
 * @param probability - Probability of true [0, 1] (default: 0.5)
 * @returns Random boolean
 * @example
 * if (secureRandomBool(0.3)) { // 30% chance
 *   doSomething()
 * }
 */
export function secureRandomBool(probability: number = 0.5): boolean {
  return secureRandom() < probability;
}

/**
 * Pick random element from array
 *
 * @param array - Array to pick from
 * @returns Random element or undefined if empty
 * @example
 * const item = secureRandomPick(['a', 'b', 'c']) // 'b'
 */
export function secureRandomPick<T>(array: T[]): T | undefined {
  if (array.length === 0) return undefined;
  return array[secureRandomInt(0, array.length - 1)];
}

/**
 * Shuffle array using Fisher-Yates with crypto randomness
 *
 * @param array - Array to shuffle (not modified)
 * @returns New shuffled array
 * @example
 * const shuffled = secureRandomShuffle([1, 2, 3, 4, 5])
 */
export function secureRandomShuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Generate Gaussian-distributed random number (for natural variance)
 *
 * Uses Box-Muller transform to generate normally distributed values
 * Human behavior follows Gaussian distributions (reaction times, typing speeds)
 *
 * @param mean - Mean of distribution
 * @param stdDev - Standard deviation
 * @returns Random value from Gaussian distribution
 * @example
 * const reactionTime = secureGaussian(250, 50) // ~250ms ± 50ms
 */
export function secureGaussian(mean: number, stdDev: number): number {
  // Box-Muller transform
  const u1 = secureRandom();
  const u2 = secureRandom();

  // Avoid log(0)
  const safeU1 = Math.max(u1, 1e-10);

  const z0 = Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2);
  return z0 * stdDev + mean;
}

/**
 * Generate value with natural human variance
 * Combines Gaussian with occasional outliers (fatigue, distraction)
 *
 * @param base - Base value
 * @param variance - Variance percentage (0.1 = ±10%)
 * @param outlierProb - Probability of outlier (default: 0.05 = 5%)
 * @returns Value with human-like variance
 * @example
 * const delay = humanVariance(200, 0.3) // 200ms ± 30% with occasional outliers
 */
export function humanVariance(
  base: number,
  variance: number,
  outlierProb: number = 0.05,
): number {
  // 5% chance of outlier (human distraction, fatigue)
  if (secureRandomBool(outlierProb)) {
    // Outlier: 1.5x to 3x the base value
    return base * secureRandomFloat(1.5, 3);
  }

  // Normal: Gaussian distribution around base
  const stdDev = base * variance;
  const value = secureGaussian(base, stdDev);

  // Ensure positive
  return Math.max(value, base * 0.1);
}

/**
 * Generate delay with natural typing rhythm
 * Simulates human typing speed variations
 *
 * @param baseMs - Base delay in milliseconds
 * @returns Delay with typing-like variance
 */
export function typingDelay(baseMs: number): number {
  const variance = 0.4;

  let delay = secureGaussian(baseMs, baseMs * variance);

  // Add occasional "thinking" pause (5% chance)
  if (secureRandomBool(0.05)) {
    delay += secureRandomInt(200, 800);
  }

  // Add skew (15% chance)
  if (secureRandomBool(0.15)) {
    delay *= secureRandomFloat(1.2, 1.8);
  }

  return Math.max(delay, baseMs * 0.2);
}
