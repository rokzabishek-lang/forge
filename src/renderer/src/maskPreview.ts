import {
  isFullFrameMask,
  maskGeometry,
  type Mask,
  type MaskGeometry,
  type WaveEdges
} from '@shared/render/mask'

/**
 * The mask, in the preview.
 *
 * Drawing only the outline and leaving the actual blur for the export is the
 * version of this feature that gets reported as broken — the same way the grade
 * sliders were, when they moved numbers nobody could see. So the effect happens
 * on screen too, at the one point in the draw loop where the clip has been
 * fitted to its box: that is the space the mask's fractions are measured in, and
 * the space ffmpeg applies them in.
 *
 * Canvas 2D can express all three modes honestly:
 *
 *   reveal  `destination-in` with the shape — the same operation as the matte
 *   blur    a blurred copy, cut to the shape, drawn back over the sharp one
 *   grade   a graded copy, cut to the shape, drawn back over the plain one
 *
 * The feather is a `blur()` on the stencil, which is what makes softness visible
 * rather than a number to be imagined. The blur radius is an approximation of
 * ffmpeg's gaussian rather than a reproduction of it — matching a separable
 * gaussian exactly in one canvas pass is not on, and the edge placement, which
 * is what people actually judge, is exact.
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
 * A rectangle whose edges have been slid along by a sine — the same curve the
 * export draws, sampled instead of solved.
 *
 * Both are written against the stream's own dimensions, and both read the sine
 * off the ABSOLUTE position in the stream rather than the position within the
 * shape. That is what lets two cells of a grid share one continuous wave: each
 * is looking at its own stretch of it. Reading it off the local offset instead
 * would restart the wave inside every cell and the pieces would not fit.
 */
function wavePath(
  ctx: CanvasRenderingContext2D,
  g: MaskGeometry,
  wave: WaveEdges,
  width: number,
  height: number
): void {
  /** Sideways slide of a vertical edge, at a local y. */
  const dx = (localY: number, amplitude: number): number => {
    const edge = wave.vertical
    if (!edge || !amplitude) return 0
    const phase = edge.cycles * ((localY + g.cy) / height) + edge.phase
    return amplitude * width * Math.sin(2 * Math.PI * phase)
  }
  /** Vertical slide of a horizontal edge, at a local x. */
  const dy = (localX: number, amplitude: number): number => {
    const edge = wave.horizontal
    if (!edge || !amplitude) return 0
    const phase = edge.cycles * ((localX + g.cx) / width) + edge.phase
    return amplitude * height * Math.sin(2 * Math.PI * phase)
  }

  const left = wave.vertical?.from ?? 0
  const right = wave.vertical?.to ?? 0
  const top = wave.horizontal?.from ?? 0
  const bottom = wave.horizontal?.to ?? 0

  // A sample every couple of pixels: past that the curve is smooth to the eye
  // and the cost is a few hundred lineTo calls on a canvas that redraws anyway.
  const stepsX = Math.max(8, Math.ceil(g.rx))
  const stepsY = Math.max(8, Math.ceil(g.ry))

  ctx.moveTo(-g.rx + dx(-g.ry, left), -g.ry + dy(-g.rx, top))
  for (let i = 1; i <= stepsX; i++) {
    const x = -g.rx + (i / stepsX) * g.rx * 2
    ctx.lineTo(x, -g.ry + dy(x, top))
  }
  for (let i = 1; i <= stepsY; i++) {
    const y = -g.ry + (i / stepsY) * g.ry * 2
    ctx.lineTo(g.rx + dx(y, right), y)
  }
  for (let i = 1; i <= stepsX; i++) {
    const x = g.rx - (i / stepsX) * g.rx * 2
    ctx.lineTo(x, g.ry + dy(x, bottom))
  }
  for (let i = 1; i <= stepsY; i++) {
    const y = g.ry - (i / stepsY) * g.ry * 2
    ctx.lineTo(-g.rx + dx(y, left), y)
  }
  ctx.closePath()
}

/** The shape as a path, in the box's own pixels. Mirrors render/mask.ts. */
function pathFor(
  ctx: CanvasRenderingContext2D,
  mask: Mask,
  width: number,
  height: number
): void {
  const g = maskGeometry(mask.shape, width, height)
  ctx.save()
  ctx.translate(g.cx, g.cy)
  ctx.rotate(g.angle)
  ctx.beginPath()
  if (mask.shape.kind === 'ellipse') {
    ctx.ellipse(0, 0, g.rx, g.ry, 0, 0, Math.PI * 2)
  } else if (mask.shape.kind === 'rectangle') {
    const wave = mask.shape.wave
    if (wave?.vertical || wave?.horizontal) {
      wavePath(ctx, g, wave, width, height)
    } else {
      // The same radius rule the export uses: a fraction of the SHORTER
      // half-extent, so the corners stay circular in a box that is not square.
      const corner = Math.max(0, Math.min(1, mask.shape.radius ?? 0)) * Math.min(g.rx, g.ry)
      if (corner > 0.5) ctx.roundRect(-g.rx, -g.ry, g.rx * 2, g.ry * 2, corner)
      else ctx.rect(-g.rx, -g.ry, g.rx * 2, g.ry * 2)
    }
  } else {
    // A half-plane: far enough in every direction to cover any rotation.
    const reach = Math.hypot(width, height)
    ctx.rect(-reach, -reach, reach * 2, reach)
  }
  ctx.fill()
  ctx.restore()
}

/**
 * The stencil: white inside the shape, transparent outside, feathered.
 *
 * Kept on its own scratch canvas so the feather blur cannot bleed the picture
 * itself — blurring a shape and blurring a photograph are one filter apart, and
 * getting them on the same canvas is how a soft mask turns into a soft image.
 */
function stencilFor(key: string, mask: Mask, width: number, height: number): Scratch | null {
  const scratch = scratchFor(`${key}:stencil`, width, height)
  if (!scratch) return null
  const { canvas, ctx } = scratch
  const g = maskGeometry(mask.shape, width, height)
  const feather = Math.max(g.featherX, g.featherY)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = feather > 1.5 ? `blur(${(feather / 2).toFixed(1)}px)` : 'none'
  ctx.fillStyle = '#fff'
  pathFor(ctx, mask, width, height)
  ctx.filter = 'none'

  if (mask.shape.invert) {
    // Punch the shape out of a full sheet rather than drawing the complement,
    // which for an ellipse is not a shape you can describe with one path.
    ctx.globalCompositeOperation = 'xor'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'source-over'
  }
  return { canvas, ctx }
}

/** Where to take the picture from, when it has not already been fitted. */
export interface SourceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * The clip with its mask applied, at box size, ready to draw whole.
 *
 * `graded` is the same picture with the clip's colour on it, needed only by
 * grade mode — where the plain copy is the background and the graded one is
 * what shows through the shape.
 */
export function maskedSource(
  key: string,
  source: CanvasImageSource,
  mask: Mask,
  rect: SourceRect | null,
  width: number,
  height: number,
  graded?: CanvasImageSource
): CanvasImageSource | null {
  if (isFullFrameMask(mask)) return null
  const w = Math.round(width)
  const h = Math.round(height)
  if (w < 2 || h < 2) return null

  const out = scratchFor(`${key}:out`, w, h)
  const stencil = stencilFor(key, mask, w, h)
  if (!out || !stencil) return null

  const { canvas, ctx } = out
  const draw = (image: CanvasImageSource, target: CanvasRenderingContext2D): void => {
    if (rect) target.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h)
    else target.drawImage(image, 0, 0, w, h)
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, w, h)

  if (mask.mode === 'reveal') {
    draw(source, ctx)
    // Keep the picture only where the stencil has ink — the same operation the
    // matte uses, and the same one alphamerge performs at export.
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(stencil.canvas, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    return canvas
  }

  // The untouched picture underneath.
  draw(source, ctx)

  // The affected copy, cut to the shape, on its own canvas so cutting it does
  // not cut the background out from under it.
  const inner = scratchFor(`${key}:inner`, w, h)
  if (!inner) return canvas
  inner.ctx.setTransform(1, 0, 0, 1, 0, 0)
  inner.ctx.globalCompositeOperation = 'source-over'
  inner.ctx.clearRect(0, 0, w, h)
  if (mask.mode === 'blur') {
    /*
     * A blur samples beyond its own edges, so a copy drawn at exactly box size
     * fades towards transparent at the border and leaves a pale rim. Drawing it
     * slightly oversized pushes that artefact off the canvas.
     */
    const bleed = Math.ceil(mask.blur)
    inner.ctx.filter = `blur(${Math.max(0.5, mask.blur / 2).toFixed(1)}px)`
    if (rect) {
      inner.ctx.drawImage(
        source, rect.sx, rect.sy, rect.sw, rect.sh,
        -bleed, -bleed, w + bleed * 2, h + bleed * 2
      )
    } else {
      inner.ctx.drawImage(source, -bleed, -bleed, w + bleed * 2, h + bleed * 2)
    }
    inner.ctx.filter = 'none'

    /*
     * Put the original silhouette back before the shape is applied.
     *
     * Canvas blurs alpha along with colour, so a transparent layer — a text
     * card, a sticker — grew a soft halo out beyond its own edges. ffmpeg does
     * not do that: the export blurs the colour planes and restores the clip's
     * own alpha, so the letters keep their exact shape and only their fill goes
     * soft. Caught in the harness at a large blur radius, where the preview
     * glowed and the export would not have. Multiplying the blurred copy back
     * by the source's alpha makes the two agree.
     *
     * For opaque media — a face, a background, everything this tool is actually
     * for — both are a plain blur and this step changes nothing.
     */
    inner.ctx.globalCompositeOperation = 'destination-in'
    draw(source, inner.ctx)
  } else {
    // Grade mode: nothing to show unless a graded copy was handed over. It
    // carries the same alpha as the source, so there is no silhouette to repair.
    if (!graded) return canvas
    draw(graded, inner.ctx)
  }
  // Confine whatever that produced to the shape.
  inner.ctx.globalCompositeOperation = 'destination-in'
  inner.ctx.drawImage(stencil.canvas, 0, 0)
  inner.ctx.globalCompositeOperation = 'source-over'

  ctx.drawImage(inner.canvas, 0, 0)
  return canvas
}

/** Drop a clip's scratch canvases — deleted, or no longer masked. */
export function forgetMask(key: string): void {
  scratches.delete(`${key}:out`)
  scratches.delete(`${key}:inner`)
  scratches.delete(`${key}:stencil`)
}
