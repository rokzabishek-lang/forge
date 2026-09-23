/**
 * Masks — a shape on the picture, and something that happens only inside it.
 *
 * Resolve calls this a Power Window, CapCut calls it a Mask, and the research
 * said the same thing both times: in a video editor the "toolbox" people ask
 * for is not a paint toolbox. Nobody wants to push pixels around frame by
 * frame. What they want is to *confine* something — blur this face, darken
 * that corner, warm only the sky — and have it hold for the length of a shot.
 *
 * So a mask here is a region plus a verb, never a brush stroke:
 *
 *   reveal  show the clip only inside the shape
 *   blur    blur inside the shape — invert it and you have blurred the background
 *   grade   the clip's own colour applies only inside the shape
 *
 * The shape maths lives here, in one place, because it is needed twice: once as
 * a `geq` expression for the export and once as a canvas drawing for the
 * preview. Two copies of an ellipse is two ellipses that eventually disagree,
 * and the one you cannot see while editing is the one that ships.
 */

export type MaskKind = 'rectangle' | 'ellipse' | 'linear'
export type MaskMode = 'reveal' | 'blur' | 'grade'

/**
 * A sine pushed through a facing pair of a rectangle's edges.
 *
 * DISPLACEMENT, not width modulation, and the distinction is the whole reason
 * this works. Widening a cell by `sin` moves its two edges in opposite
 * directions, so the cell next door — which widens by the same amount at the
 * same height — either overlaps it or leaves a gap. Sliding both edges the same
 * way instead means one cell's right edge and its neighbour's left edge are
 * literally the same curve, and a photograph cut into wavy pieces goes back
 * together with no seam.
 *
 * `phase` is what makes that true across a grid: a cell in the second row is
 * looking at a later stretch of the same wave, and says so.
 *
 * The two amplitudes are separate because the edges of the grid are not like
 * the edges inside it. An interior cut has to wave — that is the effect — but
 * the outermost edge of the outermost cell is the edge of the picture, and
 * waving that carves notches out of the frame and shows the black behind it.
 * Setting one amplitude to zero leaves that edge straight while its opposite
 * side still interlocks with its neighbour.
 */
export interface WaveEdge {
  /** Sine cycles across the stream, on the axis that DRIVES the displacement. */
  cycles: number
  /** Offset in cycles — so neighbouring cells share one continuous wave. */
  phase: number
  /**
   * Displacement of the lower edge — left, or top.
   *
   * A fraction of the STREAM's own size on the axis the edge travels along, not
   * of the shape's half-extent: two cells of a grid must slide by the same
   * number of pixels to stay interlocked, and only the stream is a length both
   * of them agree on.
   */
  from: number
  /** Displacement of the upper edge — right, or bottom. Same units. */
  to: number
}

export interface WaveEdges {
  /** Left and right edges, slid sideways by a sine running down the frame. */
  vertical?: WaveEdge
  /** Top and bottom edges, slid up and down by a sine running across it. */
  horizontal?: WaveEdge
}

export interface MaskShape {
  kind: MaskKind
  /** Centre, as a fraction of the canvas, so it survives an aspect change. */
  x: number
  y: number
  /** Half-width and half-height, again as a fraction of the canvas. */
  width: number
  height: number
  /** Degrees, clockwise, about the centre. */
  rotation: number
  /**
   * Edge softness, as a fraction of the radius.
   *
   * The single control that separates a mask you notice from one you do not. A
   * hard-edged blur over a face reads as a sticker; the same blur with a little
   * feather reads as a lens. Zero is allowed because a hard edge is right for a
   * split screen.
   */
  feather: number
  /**
   * Corner radius for a rectangle, as a fraction of its shorter half-extent.
   *
   * 0 is a hard-cornered box and 1 is a stadium. Measured against the shorter
   * side so the corners stay circular instead of stretching into ovals when the
   * box is not square. Rounded corners are most of what separates a
   * picture-in-picture that looks placed from one that looks pasted on.
   *
   * Optional, so every mask saved before this existed still opens square.
   */
  radius?: number
  /**
   * Wavy edges instead of straight ones, for a `rectangle`.
   *
   * Optional and ignored by every other kind, so a mask saved before this
   * existed still opens with straight sides. Takes precedence over `radius`:
   * a rounded corner on a wave is two ideas about the same edge.
   */
  wave?: WaveEdges
  /** Swap inside for outside — how a face blur becomes a background blur. */
  invert: boolean
}

export interface Mask {
  shape: MaskShape
  mode: MaskMode
  /** Blur radius in canvas pixels, for `blur`. */
  blur: number
}

export const MASK_KINDS: MaskKind[] = ['rectangle', 'ellipse', 'linear']

export const MASK_MODE_LABEL: Record<MaskMode, string> = {
  reveal: 'Show only inside',
  blur: 'Blur inside',
  grade: 'Colour only inside'
}

export const MASK_MODE_HINT: Record<MaskMode, string> = {
  reveal: 'Everything outside the shape becomes transparent, so the track below shows through.',
  blur: 'Blurs inside the shape. Invert it for a face in focus against a soft background.',
  grade: 'The clip’s white balance, brightness, contrast, curves and look apply only inside the shape.'
}

export function defaultMask(mode: MaskMode = 'blur'): Mask {
  return {
    mode,
    // Big enough to see and grab the moment it appears. A mask that starts at
    // zero size looks like the button did nothing.
    shape: {
      kind: 'ellipse',
      x: 0.5,
      y: 0.5,
      width: 0.25,
      height: 0.25,
      rotation: 0,
      feather: 0.2,
      invert: false
    },
    blur: 24
  }
}

/** The shape in canvas pixels, which is what both the export and the preview need. */
export interface MaskGeometry {
  cx: number
  cy: number
  /** Half-extents, never below a pixel — a zero radius is a division by zero. */
  rx: number
  ry: number
  /** Radians, clockwise on screen (y grows downward). */
  angle: number
  /** Feather in pixels, along each axis. */
  featherX: number
  featherY: number
}

export function maskGeometry(shape: MaskShape, width: number, height: number): MaskGeometry {
  const rx = Math.max(1, Math.abs(shape.width) * width)
  const ry = Math.max(1, Math.abs(shape.height) * height)
  /*
   * A feather of zero has to stay a hard edge without dividing by zero, and the
   * smallest step that still means "hard" is one pixel: at a feather of 1px the
   * expression crosses from 0 to 1 within a single pixel, which is a hard edge
   * as far as the output is concerned.
   */
  const feather = Math.max(0, shape.feather)
  return {
    cx: shape.x * width,
    cy: shape.y * height,
    rx,
    ry,
    angle: (shape.rotation * Math.PI) / 180,
    featherX: Math.max(1, feather * rx),
    featherY: Math.max(1, feather * ry)
  }
}

/**
 * The shape as a `geq` expression, 0..255.
 *
 * Verified against the bundled binary rather than assumed: `hypot`, `clip`,
 * `abs` and `min` are all present, and the values come back matching this maths
 * to within a rounding step — a probe at 70% of the radius with a 0.3 feather
 * predicted 141.7 and rendered 141.
 *
 * Every length is written against geq's own `W` and `H` variables rather than
 * baked in as a pixel count, which buys two separate things.
 *
 * First, subsampling. geq runs once per plane, and a subsampled format's chroma
 * planes are half size — an expression in absolute pixels draws a half-scale
 * shape in the corner of those planes. Measured: a centred circle came back as
 * a washed-out smear, because the luma said "inside" where the chroma said
 * "outside". With W and H the shape lands identically on every plane.
 *
 * Second, and the reason this is not merely tidier: by the time a mask is
 * applied the clip has been fitted to its BOX, which equals the canvas only
 * when the clip fills the frame. A picture-in-picture is smaller, and a mask
 * sized for the canvas would have been wrong for every one of them. Sizing off
 * the stream makes the mask a property of the clip, so it travels with a PiP
 * when that PiP is moved — which is what anyone would expect of it.
 *
 * The rotation is folded in as two precomputed constants rather than calls to
 * sin and cos, because this is evaluated once per pixel per plane per frame.
 */
export function maskExpression(shape: MaskShape): string {
  const n = (value: number): string => value.toFixed(5)
  const radians = (shape.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  /*
   * Half-extents and feather as fractions of the stream, never quite zero: a
   * zero radius divides by zero, and a zero feather has to stay a hard edge
   * without becoming one. A feather under a thousandth of the frame crosses
   * from nothing to everything inside a single pixel, which IS a hard edge as
   * far as the output is concerned.
   */
  const rx = `${n(Math.max(0.002, Math.abs(shape.width)))}*W`
  const ry = `${n(Math.max(0.002, Math.abs(shape.height)))}*H`
  const soft = Math.max(0.0008, shape.feather)
  const fx = `${n(Math.max(0.002, Math.abs(shape.width)) * soft)}*W`
  const fy = `${n(Math.max(0.002, Math.abs(shape.height)) * soft)}*H`

  // Coordinates in the shape's own frame, so every shape below ignores rotation.
  const dx = `(X-${n(shape.x)}*W)`
  const dy = `(Y-${n(shape.y)}*H)`
  const xr = `(${n(cos)}*${dx}+${n(sin)}*${dy})`
  const yr = `(${n(-sin)}*${dx}+${n(cos)}*${dy})`

  let inside: string
  switch (shape.kind) {
    case 'ellipse':
      // hypot of the normalised offsets is 1 exactly on the edge, whatever the
      // aspect — so one feather number works for a circle and a long oval alike.
      inside = `clip((1-hypot(${xr}/(${rx}),${yr}/(${ry})))/${n(soft)},0,1)`
      break
    case 'rectangle': {
      const wave = shape.wave
      if (wave?.vertical || wave?.horizontal) {
        /*
         * The same rectangle, with one pair of edges slid along by a sine.
         *
         * Each displacement is driven by the OTHER axis — the left and right
         * edges wander sideways as you travel down the frame — and is measured
         * in stream pixels off that axis's own half-extent, so it survives the
         * chroma planes being half size along with everything else here.
         *
         * Verified against the bundled binary before it was written: `sin` and
         * `PI` are both available to geq, and a probe at 0.4W ± a 0.1W wave of
         * two cycles put its edges at 40/360, 80/400 and 0/320 on the rows
         * where the sine reads 0, +1 and −1. Predicted to the pixel.
         */
        const slide = (
          edge: WaveEdge | undefined,
          amplitude: number,
          /** The dimension the edge MOVES along — W sideways, H up and down. */
          moves: 'W' | 'H',
          /** The axis the sine is read along. */
          driver: 'X/W' | 'Y/H'
        ): string => {
          if (!edge || Math.abs(amplitude) < 0.0001) return '0'
          return (
            `${n(amplitude)}*${moves}*` +
            `sin(2*PI*(${n(edge.cycles)}*${driver}+${n(edge.phase)}))`
          )
        }
        /*
         * Each edge tested on its own, rather than as one `abs` about the
         * centre. An `abs` can only describe two edges that move together,
         * which is right in the middle of a grid and wrong at its border —
         * where the outer edge has to stay straight while the inner one waves.
         */
        const side = (
          edge: WaveEdge | undefined,
          moves: 'W' | 'H',
          driver: 'X/W' | 'Y/H',
          coordinate: string,
          half: string,
          feather: string
        ): string => {
          const low = slide(edge, edge?.from ?? 0, moves, driver)
          const high = slide(edge, edge?.to ?? 0, moves, driver)
          return (
            `min(clip(((${coordinate})-(-(${half})+(${low})))/(${feather}),0,1),` +
            `clip((((${half})+(${high}))-(${coordinate}))/(${feather}),0,1))`
          )
        }
        inside =
          `min(${side(wave.vertical, 'W', 'Y/H', xr, rx, fx)},` +
          `${side(wave.horizontal, 'H', 'X/W', yr, ry, fy)})`
        break
      }
      const corner = Math.max(0, Math.min(1, shape.radius ?? 0))
      if (corner <= 0.001) {
        // Each axis fades on its own and the smaller wins, which rounds the
        // corners the way a real feathered rectangle rounds them.
        inside =
          `min(clip(((${rx})-abs(${xr}))/(${fx}),0,1),` +
          `clip(((${ry})-abs(${yr}))/(${fy}),0,1))`
        break
      }
      /*
       * A genuinely rounded rectangle — the picture-in-picture look.
       *
       * The standard rounded-box distance: pull the corner radius in from both
       * half-extents, measure how far outside that inner box the point is on
       * each axis, and take the length of the pair. Inside the flat edges one
       * of the two is zero, so the distance collapses to the ordinary edge
       * distance and the sides stay straight; only near a corner do both
       * contribute, and there the result is the arc.
       *
       * `max` is what makes it work and is not obviously available — measured
       * against the bundled binary before this was written, and it is.
       *
       * The radius is a fraction of the SHORTER half-extent so the corners stay
       * circular rather than stretching with the box.
       */
      const shorter = Math.min(
        Math.max(0.002, Math.abs(shape.width)),
        Math.max(0.002, Math.abs(shape.height))
      )
      const r = `${n(shorter * corner)}*H`
      const ax = `max(abs(${xr})-((${rx})-${r}),0)`
      const ay = `max(abs(${yr})-((${ry})-${r}),0)`
      // One feather in pixels, so the corner and the flat edges fade together.
      const edge = `${n(Math.max(0.0015, shorter * soft))}*H`
      inside = `clip(((${r})-hypot(${ax},${ay}))/(${edge}),0,1)`
      break
    }
    case 'linear':
      // A half-plane: everything on one side of a line through the centre. The
      // edge sits at half strength, so rotating it does not shift the horizon.
      inside = `clip(0.5-${yr}/(${fy}),0,1)`
      break
  }

  const value = shape.invert ? `(1-(${inside}))` : inside
  return `(${value})*255`
}

/** Nothing is masked off — emit no filter and pay nothing per frame. */
export function isFullFrameMask(mask: Mask | undefined): boolean {
  if (!mask) return true
  if (mask.mode === 'blur' && mask.blur <= 0) return true
  const { shape } = mask
  // An inverted shape of no size covers everything, which is also a no-op.
  if (!shape.invert && (shape.width <= 0 || shape.height <= 0)) return true
  return false
}
