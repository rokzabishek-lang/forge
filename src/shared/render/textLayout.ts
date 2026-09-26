import type { TextSpec } from '../timeline'
import { TITLE_SAFE } from '../timeline'

/**
 * Where the words go.
 *
 * Extracted because three places need the same answer and were each working it
 * out separately: the rasteriser that bakes the PNG, the on-picture editor that
 * draws a box round the type, and the SVG builder. Three copies of a placement
 * rule is three chances for the box you drag to sit somewhere the export does
 * not.
 *
 * Everything is in canvas pixels.
 */

export interface TextLayout {
  fontPx: number
  lineHeight: number
  /** Letter spacing in pixels — per-em in the spec, absolute here. */
  tracking: number
  lines: string[]
  /** Horizontal anchor. What it means depends on `anchor`. */
  x: number
  /** Baseline of the first line. */
  firstBaseline: number
  blockHeight: number
  /** Title-safe inset, both sides. */
  marginX: number
  anchor: 'start' | 'middle' | 'end'
  /** Top of the block — what a CSS box needs, rather than a baseline. */
  top: number
  shadow: { dy: number; blur: number; opacity: number } | null
  strokeWidth: number
}

/** Cap height sits a little above the em box; this is the usual approximation. */
export const ASCENT = 0.82
export const LINE_HEIGHT = 1.18

export function layoutText(spec: TextSpec, width: number, height: number): TextLayout {
  const fontPx = Math.max(8, Math.round(spec.size * height))
  const lineHeight = Math.round(fontPx * LINE_HEIGHT)
  const lines = (spec.uppercase ? spec.content.toUpperCase() : spec.content).split('\n')

  const anchor = spec.align === 'left' ? 'start' : spec.align === 'right' ? 'end' : 'middle'
  // Captions keep a wider boundary than a title does; everything else takes the
  // SMPTE title-safe inset.
  const marginX = Math.round(width * (spec.margin ?? TITLE_SAFE))
  const anchorX =
    spec.align === 'left' ? marginX : spec.align === 'right' ? width - marginX : Math.round(width / 2)

  const blockHeight = lines.length * lineHeight
  const ascent = fontPx * ASCENT
  const anchorBaseline =
    spec.position === 'top'
      ? Math.round(height * TITLE_SAFE + ascent)
      : spec.position === 'lower'
        ? // The lower-third convention: the block sits in the bottom third,
          // clear of the title-safe edge.
          Math.round(height * (1 - TITLE_SAFE) - blockHeight + ascent)
        : Math.round((height - blockHeight) / 2 + ascent)

  // Dragged on the picture. The anchored spot is where it starts, not where it
  // has to stay.
  const x = Math.round(anchorX + (spec.offsetX ?? 0) * width)
  const firstBaseline = Math.round(anchorBaseline + (spec.offsetY ?? 0) * height)

  const shadowOpacity = Math.max(0, Math.min(1, spec.shadow))
  return {
    fontPx,
    lineHeight,
    tracking: spec.tracking * fontPx,
    lines,
    x,
    firstBaseline,
    blockHeight,
    marginX,
    anchor,
    top: firstBaseline - ascent,
    shadow:
      shadowOpacity > 0
        ? { dy: fontPx * 0.05, blur: fontPx * 0.14, opacity: shadowOpacity }
        : null,
    strokeWidth: Math.max(0, spec.stroke) * fontPx
  }
}

/**
 * Letter spacing adds a trailing gap after the LAST glyph as well, which shifts
 * centred text left by half of it. Both the SVG and the canvas do this, so both
 * need the same nudge.
 */
export function centreFix(layout: TextLayout): number {
  return layout.anchor === 'middle' ? layout.tracking / 2 : 0
}
