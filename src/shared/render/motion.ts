import type { Motion, MotionMove } from '../timeline'

/**
 * Camera-move geometry, shared by the renderer and the preview.
 *
 * The renderer compiles these numbers into a `zoompan` expression; the preview
 * feeds them straight to `drawImage`. Both are "show this rectangle of the
 * source, scaled to the output" — the same operation — so keeping the table and
 * the arithmetic in one module is what makes the preview honest rather than
 * merely similar. See docs/PARALLAX.md §3.
 */

/**
 * Where each move starts and ends, as a fraction of the pannable margin.
 *
 * 0 is hard left/top, 1 is hard right/bottom, 0.5 is centred. Drifting moves
 * stop short of the edge — running all the way to 1 puts the subject against
 * the frame edge, which reads as a mistake rather than a move.
 */
export const DRIFT = 0.35

export interface MoveSpec {
  zoom: 'in' | 'out' | 'hold'
  fx: [number, number]
  fy: [number, number]
}

const CENTRE: [number, number] = [0.5, 0.5]

export const MOVES: Record<MotionMove, MoveSpec> = {
  in: { zoom: 'in', fx: CENTRE, fy: CENTRE },
  out: { zoom: 'out', fx: CENTRE, fy: CENTRE },
  inLeft: { zoom: 'in', fx: [0.5, 0.5 - DRIFT], fy: CENTRE },
  inRight: { zoom: 'in', fx: [0.5, 0.5 + DRIFT], fy: CENTRE },
  inUp: { zoom: 'in', fx: CENTRE, fy: [0.5, 0.5 - DRIFT] },
  inDown: { zoom: 'in', fx: CENTRE, fy: [0.5, 0.5 + DRIFT] },
  outLeft: { zoom: 'out', fx: [0.5, 0.5 - DRIFT], fy: CENTRE },
  outRight: { zoom: 'out', fx: [0.5, 0.5 + DRIFT], fy: CENTRE },
  panLeft: { zoom: 'hold', fx: [0.5 + DRIFT, 0.5 - DRIFT], fy: CENTRE },
  panRight: { zoom: 'hold', fx: [0.5 - DRIFT, 0.5 + DRIFT], fy: CENTRE },
  panUp: { zoom: 'hold', fx: CENTRE, fy: [0.5 + DRIFT, 0.5 - DRIFT] },
  panDown: { zoom: 'hold', fx: CENTRE, fy: [0.5 - DRIFT, 0.5 + DRIFT] }
}

export const DEFAULT_SHAKE_HZ = 9

/**
 * Seconds for an impact to die away.
 *
 * An exponential settle, so the first wobble is the biggest and it is visually
 * over in about three time constants. Shorter than this reads as a glitch;
 * longer and it becomes a vibration.
 */
export const DEFAULT_SHAKE_DECAY = 0.16

/**
 * Per-plane amount for an anchored shake — the inverse of parallax.
 *
 * The near plane (the subject) barely moves, the far plane takes the full hit.
 * Unlike parallax this cannot expose the baked fill: a subject that does not
 * move keeps covering exactly the same pixels, so no hole can open at its edge.
 */
export function anchoredAmount(amount: number, depth: number): number {
  const clamped = Math.max(0, Math.min(1, depth))
  return amount * (1 - clamped)
}

/**
 * How much of the move the *farthest* plane gets.
 *
 * Parallax is the ratio, not the absolute travel. The first version used 0.45,
 * which is a 2.2x spread and is simply not enough to read as depth — it looked
 * like a slightly uneven Ken Burns. At 0.28 the near plane travels 3.6x further
 * than the back one, which is where it starts to look like a camera moving
 * through a scene rather than across a print. Pinning the background at 0
 * instead reads as a cardboard cut-out sliding over a photograph.
 */
export const PARALLAX_FLOOR = 0.28

/**
 * The most travel parallax may be given, whatever the motion slider says.
 *
 * Each plane is baked with a fill band behind it (FILL_FRACTION in depth.py);
 * push the planes apart by more than that band and the nearest one slides off
 * its own filled edge, exposing the hole it was meant to cover. A point at the
 * frame edge displaces by about half the amount, and the spread between the
 * front and back planes is `amount * (1 - PARALLAX_FLOOR)`, so:
 *
 *     0.5 * amount * (1 - PARALLAX_FLOOR) <= 0.06   =>   amount <= ~0.166
 *
 * Derived rather than guessed, so changing the fill band changes this with it.
 */
export const PARALLAX_FILL_FRACTION = 0.06
export const MAX_PARALLAX_AMOUNT =
  (2 * PARALLAX_FILL_FRACTION) / (1 - PARALLAX_FLOOR)

/** Per-plane move amount. `depth` is 0 at the back, 1 at the front. */
export function planeAmount(amount: number, depth: number): number {
  const clamped = Math.max(0, Math.min(1, depth))
  const capped = Math.min(amount, MAX_PARALLAX_AMOUNT)
  return capped * (PARALLAX_FLOOR + (1 - PARALLAX_FLOOR) * clamped)
}

export function clampAmount(amount: number): number {
  return Math.max(0.01, Math.min(0.5, amount))
}

/**
 * Where in its move a clip is, `into` frames after its own first frame.
 *
 * The one rule for the preview and the export: progress runs 0..1 across the
 * move's whole length, and a clip that is a window onto a longer move (a
 * split, timeline.ts MotionWindow) starts part-way in. `seconds` is the same
 * position as time, which only a shake reads.
 */
export function moveAt(
  motion: Pick<Motion, 'window'>,
  durationFrames: number,
  into: number,
  fps: number
): { progress: number; seconds: number } {
  const from = motion.window?.from ?? 0
  const length = motion.window?.length ?? durationFrames
  const frame = from + into
  return { progress: length > 1 ? frame / (length - 1) : 0, seconds: frame / Math.max(1, fps) }
}

/** `moveAt` as ffmpeg expressions of `on`, zoompan's output frame index. */
export function moveExpressions(
  motion: Pick<Motion, 'window'>,
  durationFrames: number,
  fps: number
): { progress: string; seconds: string } {
  const from = Math.round(motion.window?.from ?? 0)
  const length = Math.max(2, Math.round(motion.window?.length ?? durationFrames))
  const frame = from > 0 ? `(${from}+on)` : 'on'
  return { progress: `${frame}/${length - 1}`, seconds: `${frame}/${fps}` }
}

export interface SourceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * The rectangle of the source visible at a point in the move.
 *
 * `progress` is 0..1 across the clip; `seconds` is elapsed time, which only
 * `shake` needs. Returns source pixels, so the caller scales to wherever it is
 * drawing.
 */
export function motionSourceRect(
  motion: Motion,
  progress: number,
  seconds: number,
  width: number,
  height: number,
  overrideAmount?: number
): SourceRect {
  const amount = clampAmount(overrideAmount ?? motion.amount)
  const p = Math.max(0, Math.min(1, progress))

  let zoom: number
  let fx: number
  let fy: number

  if (motion.kind === 'shake') {
    zoom = 1 + amount
    const hz = Math.max(1, Math.min(30, motion.hz ?? DEFAULT_SHAKE_HZ))
    const decay = Math.max(0, motion.decay ?? DEFAULT_SHAKE_DECAY)
    // Settles to the centre of its own margin, so the shot ends on a slight
    // punch-in rather than snapping back.
    const envelope = decay > 0 ? Math.exp(-seconds / decay) : 1
    fx = 0.5 + 0.5 * envelope * Math.sin(2 * Math.PI * hz * seconds)
    // A quarter-cycle apart, or the two axes move as one diagonal line.
    fy = 0.5 + 0.5 * envelope * Math.sin(2 * Math.PI * hz * seconds + Math.PI / 2)
  } else {
    const move = MOVES[motion.direction] ?? MOVES.in
    zoom =
      move.zoom === 'in' ? 1 + amount * p : move.zoom === 'out' ? 1 + amount * (1 - p) : 1 + amount
    fx = move.fx[0] + (move.fx[1] - move.fx[0]) * p
    fy = move.fy[0] + (move.fy[1] - move.fy[0]) * p
  }

  const sw = width / zoom
  const sh = height / zoom
  return {
    sx: (width - sw) * fx,
    sy: (height - sh) * fy,
    sw,
    sh
  }
}
