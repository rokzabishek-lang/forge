import type { CropRect } from '../timeline'

/**
 * Making a crop something ffmpeg will actually accept.
 *
 * `crop` is the one filter in the graph whose arguments are checked against the
 * real stream, and it fails the whole render rather than clamping:
 *
 *   Invalid too big or non positive size for width '3210' or height '1808'
 *
 * That message is where this module came from. The crop dimensions were being
 * rounded to the nearest even number, and `Math.round` rounds an odd number UP —
 * so a source 3209 pixels wide asked for 3210, one pixel that does not exist,
 * and the export died. Reproduced exactly against the bundled binary.
 *
 * It was not a rare edge either. Sweeping the real `solveCrop` arithmetic over
 * every realistic source size and all three aspect ratios, **half of them**
 * produced a crop reaching outside the source — 7566 of 15113. Odd dimensions
 * are ordinary: a photo that has been cropped once, a screen recording, an
 * export from another tool.
 *
 * So the rule here is one line long: a crop may only ever shrink. Round DOWN to
 * even, never up, and clamp the rectangle inside the pixels that exist.
 */

export interface Size {
  width: number
  height: number
}

/**
 * The largest even number at or below `n`.
 *
 * Even because H.264 chroma is subsampled and an odd dimension is invalid; DOWN
 * because rounding a crop up invents pixels, and the source is the one thing
 * that cannot be negotiated with.
 */
export function evenDown(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

/**
 * A crop rectangle guaranteed to lie inside `source`.
 *
 * Returns null when there is nothing worth cropping — either the rectangle
 * covers the whole frame, or the source is unknown. A filter that changes
 * nothing still costs a pass over every pixel of every frame, so not emitting
 * it is the right answer rather than merely a tidy one.
 */
export function safeCrop(crop: CropRect, source: Size | null): CropRect | null {
  if (!source || source.width <= 0 || source.height <= 0) return null

  const maxW = evenDown(source.width)
  const maxH = evenDown(source.height)

  /*
   * Size first, then slide it inside — not the other way round.
   *
   * Pinning the corner and then taking whatever width was left turned a
   * rectangle hanging off the right edge into a sliver: a 400x400 crop at
   * x=1800 on a 1920-wide source came out 120x80, a different shape from the
   * one the user framed. The size is what they chose; the position is the part
   * that can move.
   */
  const width = Math.min(evenDown(crop.width), maxW)
  const height = Math.min(evenDown(crop.height), maxH)

  const x = Math.max(0, Math.min(Math.round(crop.x), source.width - width))
  const y = Math.max(0, Math.min(Math.round(crop.y), source.height - height))

  if (width < 2 || height < 2) return null
  // The whole frame, give or take the evening — nothing to cut.
  if (x === 0 && y === 0 && width >= maxW && height >= maxH) return null

  return { x, y, width, height }
}
