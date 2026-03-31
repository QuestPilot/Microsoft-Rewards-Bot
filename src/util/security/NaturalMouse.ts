/**
 * Natural Mouse Movement using Bézier Curves
 *
 * CRITICAL: Linear mouse movements are a MAJOR bot detection signal
 * Real humans move mice in curved, imperfect trajectories
 *
 * This module generates:
 * - Curved paths using cubic Bézier curves
 * - Natural overshoot and correction
 * - Variable speed (acceleration/deceleration)
 * - Slight tremor (hand shake)
 * - Occasional pauses mid-movement
 *
 * DETECTION VECTORS ADDRESSED:
 * 1. Path linearity (solved: Bézier curves)
 * 2. Constant velocity (solved: easing functions)
 * 3. Perfect precision (solved: overshoot + tremor)
 * 4. No micro-corrections (solved: correction patterns)
 */

import {
    secureGaussian,
    secureRandomBool,
    secureRandomFloat,
    secureRandomInt,
} from "./SecureRandom";

export interface Point {
  x: number;
  y: number;
}

export interface MousePath {
  points: Point[];
  durations: number[]; // Duration for each segment in ms
}

/**
 * Calculate cubic Bézier curve point at parameter t
 *
 * @param p0 - Start point
 * @param p1 - First control point
 * @param p2 - Second control point
 * @param p3 - End point
 * @param t - Parameter [0, 1]
 * @returns Point on curve
 */
function cubicBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;

  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Generate random control points for natural curve
 *
 * @param start - Start point
 * @param end - End point
 * @returns Two control points for cubic Bézier
 */
function generateControlPoints(start: Point, end: Point): [Point, Point] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Control point spread based on distance
  const spread = Math.min(distance * 0.5, 200); // Max 200px spread

  // First control point: near start, with random offset
  const angle1 = Math.atan2(dy, dx) + secureRandomFloat(-0.8, 0.8);
  const dist1 = distance * secureRandomFloat(0.2, 0.5);
  const cp1: Point = {
    x:
      start.x +
      Math.cos(angle1) * dist1 +
      secureRandomFloat(-spread, spread) * 0.3,
    y:
      start.y +
      Math.sin(angle1) * dist1 +
      secureRandomFloat(-spread, spread) * 0.3,
  };

  // Second control point: near end, with random offset
  const angle2 = Math.atan2(-dy, -dx) + secureRandomFloat(-0.8, 0.8);
  const dist2 = distance * secureRandomFloat(0.2, 0.5);
  const cp2: Point = {
    x:
      end.x +
      Math.cos(angle2) * dist2 +
      secureRandomFloat(-spread, spread) * 0.3,
    y:
      end.y +
      Math.sin(angle2) * dist2 +
      secureRandomFloat(-spread, spread) * 0.3,
  };

  return [cp1, cp2];
}

/**
 * Apply easing function for natural acceleration/deceleration
 * Uses ease-in-out with variance
 *
 * @param t - Linear parameter [0, 1]
 * @returns Eased parameter [0, 1]
 */
function naturalEasing(t: number): number {
  // Base ease-in-out cubic
  const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  // Add slight noise (hand tremor)
  const noise = secureRandomFloat(-0.02, 0.02);

  return Math.max(0, Math.min(1, eased + noise));
}

/**
 * Add tremor to point (simulates hand shake)
 *
 * @param point - Original point
 * @param intensity - Tremor intensity (0-1)
 * @returns Point with tremor
 */
function addTremor(point: Point, intensity: number = 0.3): Point {
  const tremor = intensity * 3; // Max 3px tremor
  return {
    x: point.x + secureGaussian(0, tremor),
    y: point.y + secureGaussian(0, tremor),
  };
}

/**
 * Generate overshoot pattern
 * Humans often overshoot target and correct
 *
 * @param target - Target point
 * @param direction - Movement direction (dx, dy)
 * @returns Overshoot point
 */
function generateOvershoot(target: Point, direction: Point): Point {
  const overshootDist = secureRandomFloat(5, 25); // 5-25px overshoot
  const overshootAngle =
    Math.atan2(direction.y, direction.x) + secureRandomFloat(-0.3, 0.3);

  return {
    x: target.x + Math.cos(overshootAngle) * overshootDist,
    y: target.y + Math.sin(overshootAngle) * overshootDist,
  };
}

/**
 * Generate natural mouse path between two points
 *
 * CRITICAL: This is the main function for anti-detection mouse movement
 *
 * @param start - Starting position
 * @param end - Target position
 * @param options - Configuration options
 * @returns Path with points and timing
 *
 * @example
 * const path = generateMousePath(
 *   { x: 100, y: 100 },
 *   { x: 500, y: 300 },
 *   { speed: 1.0, overshoot: true }
 * )
 * for (let i = 0; i < path.points.length; i++) {
 *   await page.mouse.move(path.points[i].x, path.points[i].y)
 *   await page.waitForTimeout(path.durations[i])
 * }
 */
export function generateMousePath(
  start: Point,
  end: Point,
  options: {
    speed?: number; // Speed multiplier (1.0 = normal)
    overshoot?: boolean; // Whether to add overshoot
    tremor?: number; // Tremor intensity (0-1)
    steps?: number; // Override auto step count
  } = {},
): MousePath {
  const speed = options.speed ?? 1.0;
  const overshoot = options.overshoot ?? secureRandomBool(0.3); // 30% chance by default
  const tremor = options.tremor ?? 0.3;

  // Calculate distance
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Auto-calculate steps based on distance (with variance)
  const baseSteps = Math.max(5, Math.min(50, Math.floor(distance / 10)));
  const steps =
    options.steps ?? Math.round(secureGaussian(baseSteps, baseSteps * 0.2));

  // Generate Bézier curve control points
  const [cp1, cp2] = generateControlPoints(start, end);

  // Generate main path
  const points: Point[] = [];
  const durations: number[] = [];

  // Base duration per step (faster for longer distances)
  const baseDuration = Math.max(5, Math.min(30, 500 / steps)) / speed;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const easedT = naturalEasing(t);

    // Get point on Bézier curve
    let point = cubicBezier(start, cp1, cp2, end, easedT);

    // Add tremor (more at middle of movement)
    const tremorIntensity = tremor * Math.sin(Math.PI * t); // Peak at middle
    point = addTremor(point, tremorIntensity);

    points.push(point);

    // Variable duration (slower at start/end, faster in middle)
    const speedMultiplier = 0.5 + Math.sin(Math.PI * t); // 0.5-1.5x
    const duration = baseDuration / speedMultiplier;
    durations.push(Math.round(secureGaussian(duration, duration * 0.3)));
  }

  // Add overshoot and correction if enabled
  if (overshoot && distance > 50) {
    // Only for longer movements
    const overshootPoint = generateOvershoot(end, { x: dx, y: dy });
    points.push(overshootPoint);
    durations.push(secureRandomInt(30, 80)); // Quick overshoot

    // Correction movement back to target
    const correctionSteps = secureRandomInt(2, 4);
    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / correctionSteps;
      const correctionPoint: Point = {
        x: overshootPoint.x + (end.x - overshootPoint.x) * t,
        y: overshootPoint.y + (end.y - overshootPoint.y) * t,
      };
      points.push(addTremor(correctionPoint, tremor * 0.5));
      durations.push(secureRandomInt(20, 60));
    }
  }

  // Occasional micro-pause mid-movement (5% chance)
  if (secureRandomBool(0.05) && points.length > 5) {
    const pauseIndex = secureRandomInt(
      Math.floor(points.length * 0.3),
      Math.floor(points.length * 0.7),
    );
    durations[pauseIndex] = secureRandomInt(100, 400);
  }

  return { points, durations };
}

/**
 * Generate natural scroll path with inertia
 *
 * @param totalDelta - Total scroll amount (positive = down)
 * @param options - Configuration options
 * @returns Array of scroll deltas with timing
 */
export function generateScrollPath(
  totalDelta: number,
  options: {
    speed?: number;
    smooth?: boolean;
  } = {},
): { deltas: number[]; durations: number[] } {
  const speed = options.speed ?? 1.0;
  const smooth = options.smooth ?? true;

  const deltas: number[] = [];
  const durations: number[] = [];

  if (!smooth) {
    // Single scroll event
    deltas.push(totalDelta);
    durations.push(0);
    return { deltas, durations };
  }

  // Break into multiple scroll events with inertia
  const direction = Math.sign(totalDelta);
  let remaining = Math.abs(totalDelta);

  // Initial strong scroll
  const initialPower = secureRandomFloat(0.4, 0.6);
  const initial = Math.round(remaining * initialPower);
  deltas.push(initial * direction);
  durations.push(secureRandomInt(5, 15));
  remaining -= initial;

  // Decreasing scroll events (inertia)
  while (remaining > 10) {
    const decay = secureRandomFloat(0.3, 0.6);
    const delta = Math.round(remaining * decay);
    deltas.push(delta * direction);
    durations.push(secureRandomInt(20, 50) / speed);
    remaining -= delta;
  }

  // Final small scroll
  if (remaining > 0) {
    deltas.push(remaining * direction);
    durations.push(secureRandomInt(30, 80));
  }

  return { deltas, durations };
}
