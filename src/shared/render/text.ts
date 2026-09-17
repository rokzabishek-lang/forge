import type { TextSpec } from '../timeline'
import { centreFix, layoutText } from './textLayout'

/**
 * Text as an SVG document.
 *
 * Pure and shared so it can be tested without a rasteriser — the interesting
 * part is the typography, not the PNG encoder. Verified against what librsvg
 * (which sharp uses) actually supports: `letter-spacing` widens the drawn span,
 * and `feDropShadow` produces a genuinely soft shadow rather than being ignored.
 */

/** XML-escape, or an ampersand in the user's copy produces invalid SVG. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildTextSvg(spec: TextSpec, width: number, height: number): string {
  // Placement is shared with the canvas rasteriser and the on-picture editor,
  // so the box you drag cannot sit somewhere the export does not.
  const layout = layoutText(spec, width, height)
  const { lines, anchor, x, firstBaseline, lineHeight, tracking, strokeWidth } = layout
  const fontSize = layout.fontPx
  const strokeAttrs =
    strokeWidth > 0
      ? ` stroke="${escapeXml(spec.strokeColor)}" stroke-width="${strokeWidth.toFixed(2)}"` +
        ' stroke-linejoin="round" paint-order="stroke fill"'
      : ''

  const shadow = layout.shadow?.opacity ?? 0
  const filterId = 'forge-text-shadow'
  const defs =
    shadow > 0
      ? `<defs><filter id="${filterId}" x="-30%" y="-30%" width="160%" height="160%">` +
        `<feDropShadow dx="0" dy="${(fontSize * 0.05).toFixed(2)}"` +
        ` stdDeviation="${(fontSize * 0.07).toFixed(2)}"` +
        ` flood-color="#000000" flood-opacity="${shadow.toFixed(3)}"/></filter></defs>`
      : ''
  const filterAttr = shadow > 0 ? ` filter="url(#${filterId})"` : ''

  const nudge = centreFix(layout)
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${Math.round(x + nudge)}" y="${firstBaseline + index * lineHeight}">` +
        `${escapeXml(line) || ' '}</tspan>`
    )
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${defs}` +
    `<text font-family="${escapeXml(spec.font)}" font-size="${fontSize}"` +
    ` font-weight="${Math.round(spec.weight)}" fill="${escapeXml(spec.color)}"` +
    ` text-anchor="${anchor}" letter-spacing="${tracking.toFixed(2)}"` +
    `${strokeAttrs}${filterAttr}>${tspans}</text></svg>`
  )
}

export function buildSolidSvg(
  color: string,
  opacity: number,
  width: number,
  height: number
): string {
  const alpha = Math.max(0, Math.min(1, opacity))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="${escapeXml(color)}"` +
    ` fill-opacity="${alpha.toFixed(3)}"/></svg>`
  )
}
