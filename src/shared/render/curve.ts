import { normaliseKeys, type Ease, type Keyframe } from './keyframes'

/**
 * Turning a drawn line into keyframes.
 *
 * A curve editor gives you two ways to say the same thing: drag the points, or
 * draw the shape you want. Drawing is the faster one — it is how you say "fast
 * in, slow out, then hold" without knowing that is what you mean — but a
 * freehand line is hundreds of samples and keyframes are a handful, so the line
 * has to be reduced to the points that actually carry its shape.
 *
 * Ramer–Douglas–Peucker does exactly that: keep the point furthest from the
 * straight line between the ends, recurse either side, stop when nothing is
 * further than the tolerance. A straight drag collapses to two keys; a deliberate
 * curve keeps the bend.
 */

export interface Sample {
  /** Frames from the clip's start. */
  frame: number
  value: number
}

/**
 * How far a sample may sit from the simplified line before it earns a key.
 *
 * As a fraction of the value range being drawn, so it means the same thing for
 * an opacity of 0..1 as for a rotation of -180..180.
 */
export const SIMPLIFY_TOLERANCE = 0.025

/** The most keys one drawn stroke may produce. */
export const MAX_DRAWN_KEYS = 24

/**
 * Reduce a drawn stroke to keyframes.
 *
 * `range` is the span of the property, used to make the tolerance meaningful in
 * its own units.
 */
export function keysFromStroke(
  samples: Sample[],
  durationFrames: number,
  range: number,
  ease: Ease = 'smooth'
): Keyframe[] {
  const ordered = [...samples]
    .map((s) => ({
      frame: Math.max(0, Math.min(durationFrames, Math.round(s.frame))),
      value: s.value
    }))
    .sort((a, b) => a.frame - b.frame)

  // One value per frame: a stroke that doubles back is a hand wobble, not an
  // instruction to hold two values at one instant.
  const unique: Sample[] = []
  for (const sample of ordered) {
    if (unique.length > 0 && unique[unique.length - 1].frame === sample.frame) unique.pop()
    unique.push(sample)
  }
  if (unique.length === 0) return []
  if (unique.length === 1) return [{ frame: unique[0].frame, value: unique[0].value, ease }]

  let kept = simplify(unique, SIMPLIFY_TOLERANCE, durationFrames, range)

  // Raising the tolerance is gentler than truncating: it drops the least
  // important bends rather than the end of the stroke.
  let guard = 0
  while (kept.length > MAX_DRAWN_KEYS && guard++ < 12) {
    kept = simplify(unique, SIMPLIFY_TOLERANCE * Math.pow(1.6, guard), durationFrames, range)
  }

  return normaliseKeys(
    kept.map((s) => ({ frame: s.frame, value: s.value, ease })),
    durationFrames
  )
}

/**
 * Ramer–Douglas–Peucker, iterative.
 *
 * Recursion would be fine for a mouse stroke, but a long drag on a fast pointer
 * is thousands of samples and blowing the stack while drawing is not a failure
 * anyone could interpret.
 */
function simplify(
  points: Sample[],
  tolerance: number,
  durationFrames: number,
  range: number
): Sample[] {
  if (points.length < 3) return points

  /*
   * BOTH axes are normalised, not just the tolerance.
   *
   * Frames run to hundreds and a rotation runs to 360, so measuring distance in
   * raw units lets whichever axis happens to be bigger decide the shape. Scaling
   * the tolerance alone is not enough — it fixes what counts as far without
   * fixing the direction "far" is measured in, and the same curve drawn for
   * opacity and for rotation then simplifies differently.
   */
  const span = Math.max(1, durationFrames)
  const unit = Math.max(1e-9, Math.abs(range))
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    if (last - first < 2) continue

    const a = points[first]
    const b = points[last]
    const ax = a.frame / span
    const bx = b.frame / span
    const ay = a.value / unit
    const dx = bx - ax
    const dy = b.value / unit - ay
    const length = Math.hypot(dx, dy)

    let worst = -1
    let worstDistance = 0
    for (let i = first + 1; i < last; i++) {
      const px = points[i].frame / span - ax
      const py = points[i].value / unit - ay
      // Perpendicular distance, or plain vertical distance when the segment has
      // no length to be perpendicular to.
      const distance = length < 1e-9 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / length
      if (distance > worstDistance) {
        worstDistance = distance
        worst = i
      }
    }

    if (worst >= 0 && worstDistance > tolerance) {
      keep[worst] = true
      stack.push([first, worst], [worst, last])
    }
  }

  return points.filter((_, i) => keep[i])
}
