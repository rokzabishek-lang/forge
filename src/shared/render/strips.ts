import type { CropRect, Transform } from '../timeline'
import type { Mask } from './mask'
import { DEFAULT_GRID, gridCells, type GridCell } from './grid'

/**
 * Strips — the second half of the reference template.
 *
 * Measured off it rather than guessed at: past the seven-second mark the
 * picture stops assembling and starts being interrupted. Vertical strips,
 * horizontal bands and diagonal wedges of a BRIGHTENED copy flash in and out
 * over footage that never stops running. Sampling that section one sixteenth at
 * a time shows the strips moving a notch per sample. See docs/EFFECTS.md §20.
 *
 * The important thing about it is that it is not a new effect. A strip is a
 * grid cell — `gridCells` with one row, or one column — and everything that
 * makes the two look different is a setting:
 *
 *   the grid      accumulates, shows the photograph, lands on eighths
 *   the strips    are momentary, show a treated copy, land on sixteenths
 *
 * So this module is thin. It borrows the geometry, and adds the one shape the
 * grid cannot express: a band at an angle, which is not a cell of any grid.
 */

export type StripLayout = 'vertical' | 'horizontal' | 'diagonal'

export const STRIP_LAYOUT_LABEL: Record<StripLayout, string> = {
  vertical: 'Columns',
  horizontal: 'Bands',
  diagonal: 'Diagonal'
}

export const STRIP_LAYOUT_HINT: Record<StripLayout, string> = {
  vertical: 'Full-height slices, the way the reference opens its second half.',
  horizontal: 'Full-width bands across the frame.',
  diagonal: 'Bands at an angle — the wedge that sweeps through.'
}

/** Degrees off horizontal for a diagonal band. */
export const DEFAULT_STRIP_ANGLE = 28

/**
 * One strip, as an ordinary clip's worth of geometry.
 *
 * `vertical` and `horizontal` come back as a crop and a box and cost nothing
 * per frame. `diagonal` cannot: a band at an angle is not a rectangle of the
 * source, so it is the whole frame with a turned rectangle masked out of it,
 * and that is a per-pixel expression. It is affordable here only because a
 * flash is three or four frames long.
 */
export function stripCell(
  layout: StripLayout,
  count: number,
  index: number,
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  angleDegrees = DEFAULT_STRIP_ANGLE
): GridCell | null {
  const total = Math.max(1, Math.round(count))
  const slot = ((Math.round(index) % total) + total) % total

  if (layout !== 'diagonal') {
    const spec = {
      ...DEFAULT_GRID,
      rows: layout === 'horizontal' ? total : 1,
      cols: layout === 'horizontal' ? 1 : total
    }
    const cells = gridCells(spec, source, canvas)
    return cells[slot] ?? null
  }

  return {
    index: slot,
    // A diagonal band belongs to no row or column; the slot is its position
    // across the frame and the two axes have nothing separate to say.
    row: 0,
    col: slot,
    // The whole picture, because the band crosses all of it.
    crop: { x: 0, y: 0, width: source.width, height: source.height },
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      scaleY: 1,
      fit: 'cover',
      rotation: 0,
      opacity: 1
    },
    mask: diagonalBand(slot, total, angleDegrees, canvas)
  }
}

/**
 * A band at an angle, as a mask on a full-frame clip.
 *
 * The rectangle is deliberately far longer than the frame along its own axis,
 * so its ends are never in shot whatever angle it is turned to — only the two
 * long edges should ever be visible, and a band whose end wanders into frame
 * reads as a floating box rather than a sweep.
 *
 * Shifting a band sideways is the part worth writing down. `maskExpression`
 * rotates about the shape's centre, so moving the band across the frame means
 * moving that centre along the band's own PERPENDICULAR: for a band at angle t,
 * an offset of p pixels is (-p·sin t, p·cos t). Offsetting on x alone slides the
 * band along itself, which looks like nothing happening at all.
 */
export function diagonalBand(
  slot: number,
  count: number,
  angleDegrees: number,
  canvas: { width: number; height: number }
): Mask {
  const total = Math.max(1, Math.round(count))
  const radians = (angleDegrees * Math.PI) / 180
  const sin = Math.sin(radians)
  const cos = Math.cos(radians)

  // The frame's extent measured across the band, which is how much room there
  // is to distribute bands over — wider than the frame itself at any angle.
  const reach = Math.abs(canvas.width * sin) + Math.abs(canvas.height * cos)
  const thickness = reach / total
  // Slot 0 at one edge, slot N-1 at the other, each band's middle in its share.
  const offset = (slot + 0.5) * thickness - reach / 2

  return {
    mode: 'reveal',
    blur: 0,
    shape: {
      kind: 'rectangle',
      x: 0.5 + (-sin * offset) / Math.max(1, canvas.width),
      y: 0.5 + (cos * offset) / Math.max(1, canvas.height),
      // Long enough that its ends are always outside the frame.
      width: 1.5,
      height: thickness / 2 / Math.max(1, canvas.height),
      rotation: angleDegrees,
      feather: 0.02,
      invert: false
    }
  }
}

/** Convenience for callers that only want the numbers. */
export interface StripGeometry {
  crop: CropRect
  transform: Transform
  mask?: Mask
}
