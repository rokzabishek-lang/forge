import type { Clip, PathPoint } from '../timeline'

/**
 * Turning a list of waypoints into an ffmpeg overlay position expression.
 *
 * Overlay evaluates `x` and `y` per frame against `t`, timeline seconds — the
 * transition system already depends on this, so it is the one animation
 * mechanism in the renderer that is known to work. A path compiles to nested
 * `if(lt(t,..),..,..)` segments, each linearly interpolating between two points.
 *
 * Pure, and shared with the preview, so a clip cannot travel one way on screen
 * and another in the export.
 */

/** Sorted, de-duplicated, clamped into the clip. */
/**
 * Sorted, whole-frame, one point per frame — not clamped to the clip, for the
 * same reason as `normaliseKeys`: a point past a trimmed edge still shapes the
 * move inside it, and clamping squashed it onto the last frame instead.
 */
export function normalisePath(path: PathPoint[], _durationFrames: number): PathPoint[] {
  const points = [...path]
    .map((p) => ({ ...p, frame: Math.round(p.frame) }))
    .sort((a, b) => a.frame - b.frame)

  const unique: PathPoint[] = []
  for (const point of points) {
    // A later point at the same frame wins; two values at one instant is not a
    // move, it is a contradiction.
    if (unique.length > 0 && unique[unique.length - 1].frame === point.frame) unique.pop()
    unique.push(point)
  }
  return unique
}

/** Position at a frame, linear between waypoints and held outside them. */
export function pathAt(
  path: PathPoint[],
  frame: number,
  durationFrames: number
): { x: number; y: number } | null {
  const points = normalisePath(path, durationFrames)
  if (points.length === 0) return null
  if (points.length === 1) return { x: points[0].x, y: points[0].y }

  if (frame <= points[0].frame) return { x: points[0].x, y: points[0].y }
  const last = points[points.length - 1]
  if (frame >= last.frame) return { x: last.x, y: last.y }

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (frame > b.frame) continue
    const span = b.frame - a.frame
    const progress = span <= 0 ? 1 : (frame - a.frame) / span
    return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress }
  }
  return { x: last.x, y: last.y }
}

/**
 * An overlay position expression for one axis.
 *
 * `startSeconds` is where the clip sits on the timeline, because overlay's `t`
 * is timeline time while a path is written in clip time.
 */
export function pathExpression(
  path: PathPoint[],
  axis: 'x' | 'y',
  options: {
    durationFrames: number
    fps: number
    startSeconds: number
    /** Canvas pixels per unit of path value, and the resting offset. */
    scale: number
    offset: number
  }
): string {
  const points = normalisePath(path, options.durationFrames)
  if (points.length === 0) return options.offset.toFixed(2)

  const px = (value: number): string => (options.offset + value * options.scale).toFixed(2)
  if (points.length === 1) return px(points[0][axis])

  const time = (frame: number): number => options.startSeconds + frame / options.fps

  // Built from the last segment backwards, so each `if` only has to decide
  // "are we before this point yet".
  let expression = px(points[points.length - 1][axis])
  for (let i = points.length - 1; i >= 1; i--) {
    const a = points[i - 1]
    const b = points[i]
    const t0 = time(a.frame)
    const t1 = time(b.frame)
    const from = options.offset + a[axis] * options.scale
    const to = options.offset + b[axis] * options.scale
    const span = t1 - t0

    const segment =
      span <= 1e-6
        ? to.toFixed(2)
        : `${from.toFixed(2)}+(${(to - from).toFixed(2)})*min(1,max(0,(t-${t0.toFixed(4)})/${span.toFixed(4)}))`
    expression = `if(lt(t,${t1.toFixed(4)}),${segment},${expression})`
  }
  // Before the first waypoint the clip waits where it starts.
  return `if(lt(t,${time(points[0].frame).toFixed(4)}),${px(points[0][axis])},${expression})`
}

export function hasPath(clip: Clip): boolean {
  return Array.isArray(clip.path) && clip.path.length >= 2
}

/**
 * Ready-made moves.
 *
 * A path editor is the general answer, but almost every use is one of these —
 * something entering, leaving, or crossing — and a preset is the difference
 * between a feature that exists and a feature that gets used. Values are
 * fractions of a half-canvas, so 1.3 is comfortably off the edge whatever the
 * aspect ratio.
 */
export const OFFSCREEN = 1.3

export interface PathPreset {
  id: string
  label: string
  /** Built against the clip's own length, so it always fills the shot. */
  build: (durationFrames: number) => PathPoint[]
}

const ends = (
  from: { x: number; y: number },
  to: { x: number; y: number }
): ((d: number) => PathPoint[]) => {
  return (d: number) => [
    { frame: 0, x: from.x, y: from.y },
    { frame: Math.max(1, d - 1), x: to.x, y: to.y }
  ]
}

export const PATH_PRESETS: PathPreset[] = [
  { id: 'in-left', label: 'In from left', build: ends({ x: -OFFSCREEN, y: 0 }, { x: 0, y: 0 }) },
  { id: 'in-right', label: 'In from right', build: ends({ x: OFFSCREEN, y: 0 }, { x: 0, y: 0 }) },
  { id: 'in-top', label: 'In from top', build: ends({ x: 0, y: -OFFSCREEN }, { x: 0, y: 0 }) },
  { id: 'in-bottom', label: 'In from bottom', build: ends({ x: 0, y: OFFSCREEN }, { x: 0, y: 0 }) },
  {
    id: 'across-right',
    label: 'Across →',
    build: ends({ x: -OFFSCREEN, y: 0 }, { x: OFFSCREEN, y: 0 })
  },
  {
    id: 'across-left',
    label: 'Across ←',
    build: ends({ x: OFFSCREEN, y: 0 }, { x: -OFFSCREEN, y: 0 })
  },
  { id: 'out-left', label: 'Out to left', build: ends({ x: 0, y: 0 }, { x: -OFFSCREEN, y: 0 }) },
  { id: 'out-right', label: 'Out to right', build: ends({ x: 0, y: 0 }, { x: OFFSCREEN, y: 0 }) },
  {
    id: 'drift-up',
    label: 'Drift up',
    // Small on purpose: a drift is a breath, not a move.
    build: ends({ x: 0, y: 0.08 }, { x: 0, y: -0.08 })
  },
  {
    id: 'settle',
    label: 'Slide in and settle',
    build: (d) => [
      { frame: 0, x: -OFFSCREEN, y: 0 },
      { frame: Math.round(d * 0.35), x: 0.04, y: 0 },
      { frame: Math.max(1, d - 1), x: 0, y: 0 }
    ]
  }
]

export function presetById(id: string): PathPreset | null {
  return PATH_PRESETS.find((p) => p.id === id) ?? null
}
