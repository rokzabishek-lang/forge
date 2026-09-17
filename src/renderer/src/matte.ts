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
): CanvasImageSource | null {
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
