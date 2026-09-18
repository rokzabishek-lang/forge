/**
 * Showing one picture through the shape of another, for the preview.
 *
 * The renderer does this with `alphamerge`, which takes the shape's brightness
 * as the picture's alpha. Canvas has the same operation built in:
 * `destination-in` keeps the destination only where the incoming pixel is
 * opaque. For a text clip — a transparent PNG with light letters — the letters
 * are both the bright part and the opaque part, so the two agree.
 *
 * One scratch canvas per matted clip, reused across frames: allocating a
 * full-size canvas sixty times a second is how a preview starts stuttering.
 */

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
 * The picture cut to the shape.
 *
 * `source` is drawn from the given source rectangle so a camera move inside the
 * matted clip still works; the shape is drawn whole, because it is a stencil
 * over the finished frame rather than something being moved through.
 */
export function mattedSource(
  key: string,
  source: CanvasImageSource,
  shape: CanvasImageSource,
  rect: { sx: number; sy: number; sw: number; sh: number },
  width: number,
  height: number
): HTMLCanvasElement | null {
  if (width < 1 || height < 1) return null
  const scratch = scratchFor(key, Math.round(width), Math.round(height))
  if (!scratch) return null

  const { canvas, ctx } = scratch
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height)
  // Keep the picture only where the shape has ink.
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(shape, 0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}

/** Drop a clip's scratch canvas — it was deleted, or is no longer matted. */
export function forgetMatte(key: string): void {
  scratches.delete(key)
}

/* --------------------------------------------------- luma as alpha */

/**
 * The same operation for a matte that is BRIGHT rather than opaque.
 *
 * A clip sticker's matte is a greyscale video: every pixel is fully opaque and
 * the alpha lives in the brightness. `destination-in` reads alpha, so handing
 * it one of these keeps the whole rectangle — a green box pasted over the shot,
 * which is precisely what a dropped matte looks like.
 *
 * Canvas 2D has no luma-to-alpha operator, but it does take an SVG filter, and
 * `feColorMatrix` writes alpha from a weighted sum of RGB. Measured in the
 * harness on a 4-pixel ramp: input luma 0/85/170/255 comes out as alpha
 * 0/85/170/255 exactly. It runs on the GPU, so there is no per-pixel pass here
 * at all — which matters when this happens for every sticker on every frame.
 *
 * `color-interpolation-filters="sRGB"` is load-bearing. The SVG default is
 * linearRGB, which would silently gamma-shift the matte and soften every edge.
 */
const FILTER_ID = 'forge-luma-alpha'
let filterReady = false

function ensureLumaFilter(): void {
  if (filterReady || typeof document === 'undefined') return
  if (!document.getElementById(FILTER_ID)) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.innerHTML =
      `<filter id="${FILTER_ID}" color-interpolation-filters="sRGB">` +
      // RGB forced to white, alpha = Rec.709 luma. Only the alpha is used.
      `<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.2126 0.7152 0.0722 0 0"/>` +
      `</filter>`
    document.body.appendChild(svg)
  }
  filterReady = true
}

/**
 * A clip sticker, cut out by its own matte.
 *
 * Both streams are drawn whole and at the same size: the pair was authored
 * together frame for frame, so anything that moved one relative to the other
 * would slide the cut-out off its subject.
 */
export function lumaMattedSource(
  key: string,
  colour: CanvasImageSource,
  matte: CanvasImageSource,
  width: number,
  height: number
): HTMLCanvasElement | null {
  if (width < 1 || height < 1) return null
  ensureLumaFilter()
  const scratch = scratchFor(key, Math.round(width), Math.round(height))
  if (!scratch) return null

  const { canvas, ctx } = scratch
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(colour, 0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.filter = `url(#${FILTER_ID})`
  ctx.drawImage(matte, 0, 0, canvas.width, canvas.height)
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}
