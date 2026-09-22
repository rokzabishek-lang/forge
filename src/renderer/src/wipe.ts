/**
 * A luma wipe, for the preview.
 *
 * The render does this with `alphamerge` over a geq-animated mask: a threshold
 * sweeps across the mask's brightness, and each pixel flips from transparent to
 * opaque as the threshold passes it. Canvas has both halves — `destination-in`
 * is alphamerge, and an `feColorMatrix` writes alpha from a weighted sum of RGB
 * plus a constant, which is exactly the straight line `lumaAlphaRamp` describes.
 * So the sweep is one attribute on one filter, updated per frame, and the GPU
 * does the per-pixel work rather than a JavaScript loop over an ImageData.
 *
 * The weights are Rec.709 while ffmpeg's `format=gray` is Rec.601. For a
 * greyscale mask — which every wipe mask in the library is, by definition —
 * R=G=B and both weightings return the identical luma, so the difference is
 * unreachable rather than tolerated.
 *
 * One scratch canvas per wiped clip, reused across frames, for the same reason
 * `matte.ts` keeps one: allocating a full-size canvas sixty times a second is
 * how a preview starts stuttering.
 */

import { lumaAlphaMatrix, LUMA_SOFTNESS } from '@shared/transitions/registry'

const FILTER_ID = 'forge-wipe-alpha'
const MATRIX_ID = `${FILTER_ID}-matrix`

let matrixElement: SVGElement | null = null

function ensureFilter(): SVGElement | null {
  if (typeof document === 'undefined') return null
  if (matrixElement?.isConnected) return matrixElement

  const existing = document.getElementById(MATRIX_ID)
  if (existing) {
    matrixElement = existing as unknown as SVGElement
    return matrixElement
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  /*
   * `color-interpolation-filters="sRGB"` is load-bearing, for the same reason
   * it is in matte.ts: the SVG default is linearRGB, which would gamma-shift
   * the mask and put the wipe's edge somewhere other than where the export
   * puts it.
   */
  svg.innerHTML =
    `<filter id="${FILTER_ID}" color-interpolation-filters="sRGB">` +
    `<feColorMatrix id="${MATRIX_ID}" type="matrix" values="${lumaAlphaMatrix(0)}"/>` +
    `</filter>`
  document.body.appendChild(svg)
  matrixElement = document.getElementById(MATRIX_ID) as unknown as SVGElement | null
  return matrixElement
}

interface Scratch {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

const scratches = new Map<string, Scratch>()

function scratchFor(key: string, width: number, height: number): Scratch | null {
  let scratch = scratches.get(key)
  if (!scratch) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    scratch = { canvas, ctx }
    scratches.set(key, scratch)
  }
  if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
    scratch.canvas.width = width
    scratch.canvas.height = height
  }
  return scratch
}

/**
 * The incoming clip, revealed through the mask as far as `progress` has swept.
 *
 * `source` is drawn from its source rectangle so a camera move inside the
 * clip still works; the mask is drawn whole and stretched to the clip's box,
 * which is what the render does too — it scales the mask to the box before the
 * geq rather than leaving it at the canvas size.
 */
export function wipedSource(
  key: string,
  source: CanvasImageSource,
  mask: CanvasImageSource,
  rect: { sx: number; sy: number; sw: number; sh: number },
  width: number,
  height: number,
  progress: number,
  softness = LUMA_SOFTNESS
): HTMLCanvasElement | null {
  if (width < 1 || height < 1) return null
  const matrix = ensureFilter()
  if (!matrix) return null
  const scratch = scratchFor(key, Math.round(width), Math.round(height))
  if (!scratch) return null

  matrix.setAttribute('values', lumaAlphaMatrix(progress, softness))

  const { canvas, ctx } = scratch
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.filter = `url(#${FILTER_ID})`
  ctx.drawImage(mask, 0, 0, canvas.width, canvas.height)
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}

/** Drop a clip's scratch canvas — it was deleted, or is no longer wiped. */
export function forgetWipe(key: string): void {
  scratches.delete(key)
}
