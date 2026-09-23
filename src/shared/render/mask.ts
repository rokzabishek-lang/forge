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

import {
  keyframeExpression,
  normaliseKeys,
  valueAt,
  type KeyedProperty,
  type KeyframeTracks
} from './keyframes'

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
export function maskExpression(shape: MaskShape, motion?: MaskMotion): string {
  const n = (value: number): string => value.toFixed(5)
  const radians = (shape.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  /*
   * A moving mask: each keyed number computed once per ROW and held.
   *
   * geq has no per-frame stage — the expression is evaluated for every pixel —
   * and the centre alone appears twice and each half-extent three or four
   * times below. `st()` stores a number in one of geq's variables and `ld()`
   * reads it back; `;` sequences them. Measured on the bundled binary inside a
   * quoted filter_complex argument: `st(0,32);if(lt(X,ld(0)),200,0)` is 200 up
   * to x=31 and 0 from x=32. Both are libavutil's eval, far older than the
   * Windows build.
   *
   * The curves depend on time alone, so they are worked out at the first
   * pixel of each row (`X` is 0) and every other pixel reads them back — geq
   * walks each row from x=0, and the variables persist between pixels.
   * Measured over 3 s at 1080x1920 with four tracks of six keys: 11.4 s for a
   * still mask, 26.8 s with the curves worked out at every pixel, 13.4 s once
   * per row — and the per-row picture byte-identical to the per-pixel one over
   * all 180 frames tested.
   *
   * `T` is the clip's own seconds here — the mask is drawn on the clip's chain
   * before it is moved to its place on the timeline — measured 0, 0.1, 0.2…
   * frame by frame at 10fps.
   */
  const keyed = (field: MaskField): string | null => {
    const keys = motion?.keyframes?.[MASK_TRACK[field]]
    if (!motion || !keys || keys.length === 0) return null
    return keyframeExpression(keys, {
      durationFrames: motion.durationFrames,
      fps: motion.fps,
      startSeconds: 0,
      fallback: shape[field],
      precision: 5,
      timeVar: 'T'
    })
  }
  const moving = { x: keyed('x'), y: keyed('y'), width: keyed('width'), height: keyed('height') }
  const stores: string[] = []
  if (moving.x) stores.push(`st(0,${moving.x})`)
  if (moving.y) stores.push(`st(1,${moving.y})`)
  if (moving.width) stores.push(`st(2,max(0.002,abs(${moving.width})))`)
  if (moving.height) stores.push(`st(3,max(0.002,abs(${moving.height})))`)
  // `+` only to evaluate every store inside one `if`; the sum is thrown away.
  const prefix = stores.length > 0 ? `if(eq(X,0),${stores.join('+')},0);` : ''
  // The half-extents as fractions of the stream: a stored value, or the number.
  const wf = moving.width ? 'ld(2)' : n(Math.max(0.002, Math.abs(shape.width)))
  const hf = moving.height ? 'ld(3)' : n(Math.max(0.002, Math.abs(shape.height)))

  /*
   * Half-extents and feather as fractions of the stream, never quite zero: a
   * zero radius divides by zero, and a zero feather has to stay a hard edge
   * without becoming one. A feather under a thousandth of the frame crosses
   * from nothing to everything inside a single pixel, which IS a hard edge as
   * far as the output is concerned.
   */
  const rx = `${wf}*W`
  const ry = `${hf}*H`
  const soft = Math.max(0.0008, shape.feather)
  // Folded into one number when the size is still, as it always was.
  const fx = moving.width ? `ld(2)*${n(soft)}*W` : `${n(Math.max(0.002, Math.abs(shape.width)) * soft)}*W`
  const fy = moving.height ? `ld(3)*${n(soft)}*H` : `${n(Math.max(0.002, Math.abs(shape.height)) * soft)}*H`

  // Coordinates in the shape's own frame, so every shape below ignores rotation.
  const dx = `(X-${moving.x ? 'ld(0)' : n(shape.x)}*W)`
  const dy = `(Y-${moving.y ? 'ld(1)' : n(shape.y)}*H)`
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
      const sizing = moving.width || moving.height
      const least = sizing ? `min(${wf},${hf})` : null
      const r = least ? `${least}*${n(corner)}*H` : `${n(shorter * corner)}*H`
      const ax = `max(abs(${xr})-((${rx})-${r}),0)`
      const ay = `max(abs(${yr})-((${ry})-${r}),0)`
      // One feather in pixels, so the corner and the flat edges fade together.
      const edge = least
        ? `max(0.0015,${least}*${n(soft)})*H`
        : `${n(Math.max(0.0015, shorter * soft))}*H`
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
  return `${prefix}(${value})*255`
}

/* ---------------------------------------------------------- a moving mask */

/**
 * Which of a clip's keyframe tracks moves which number of its mask.
 *
 * Only the centre and the size. A mask following someone across a shot, or
 * an iris opening, is those four; its angle, softness and kind stay put, and
 * keying them would be four more tracks for a rare case.
 */
export type MaskField = 'x' | 'y' | 'width' | 'height'
export const MASK_FIELDS: MaskField[] = ['x', 'y', 'width', 'height']
export const MASK_TRACK: Record<MaskField, KeyedProperty> = {
  x: 'maskX',
  y: 'maskY',
  width: 'maskWidth',
  height: 'maskHeight'
}

/** The mask number a track moves, or null for a track that is not the mask's. */
export function maskFieldOf(property: KeyedProperty): MaskField | null {
  return MASK_FIELDS.find((f) => MASK_TRACK[f] === property) ?? null
}

/** What the export needs to draw a moving mask. */
export interface MaskMotion {
  keyframes: KeyframeTracks | undefined
  fps: number
  durationFrames: number
}

/** Every frame, in the clip's own time, where any of the mask's numbers has a key. */
export function maskKeyFrames(keyframes: KeyframeTracks | undefined): number[] {
  const frames = new Set<number>()
  for (const field of MASK_FIELDS) for (const k of keyframes?.[MASK_TRACK[field]] ?? []) frames.add(Math.round(k.frame))
  return [...frames].sort((a, b) => a - b)
}

/** Does any of the mask's numbers move? */
export function isMaskAnimated(keyframes: KeyframeTracks | undefined): boolean {
  return MASK_FIELDS.some((f) => (keyframes?.[MASK_TRACK[f]]?.length ?? 0) > 0)
}

/**
 * The shape at a frame of the clip's own time.
 *
 * A track with ANY key decides its number — one key is a value, as it is in
 * the export's expression — and a number with no track is the shape's own. So
 * the first key, written where the shape already was, changes nothing, and
 * dragging the shape at that frame moves the key rather than a value the keys
 * would ignore.
 */
export function maskShapeAt(
  shape: MaskShape,
  keyframes: KeyframeTracks | undefined,
  frame: number,
  durationFrames: number
): MaskShape {
  if (!isMaskAnimated(keyframes)) return shape
  const out = { ...shape }
  for (const field of MASK_FIELDS) {
    const keys = keyframes?.[MASK_TRACK[field]]
    if (keys && keys.length > 0) out[field] = valueAt(keys, frame, durationFrames, shape[field])
  }
  return out
}

/** A clip's mask as it stands at a frame of the clip's own time. */
export function maskAt(
  clip: { mask?: Mask; keyframes?: KeyframeTracks; duration: number },
  frame: number
): Mask | undefined {
  if (!clip.mask) return undefined
  if (!isMaskAnimated(clip.keyframes)) return clip.mask
  return { ...clip.mask, shape: maskShapeAt(clip.mask.shape, clip.keyframes, frame, clip.duration) }
}

type Keyed = { mask?: Mask; keyframes?: KeyframeTracks; duration: number }

/** The frame a key goes on: the playhead, kept inside the clip. */
function keyFrame(clip: Keyed, frame: number): number {
  return Math.max(0, Math.min(Math.max(0, clip.duration - 1), Math.round(frame)))
}

function withKey(tracks: KeyframeTracks, property: KeyedProperty, frame: number, value: number, duration: number): KeyframeTracks {
  const existing = tracks[property] ?? []
  const ease = existing.find((k) => k.frame === frame)?.ease
  // normaliseKeys keeps the later of two keys at a frame, so appending replaces.
  const next = normaliseKeys([...existing, { frame, value, ...(ease ? { ease } : {}) }], duration)
  return { ...tracks, [property]: next }
}

/**
 * An edit to the mask's shape, made at a frame of the clip.
 *
 * The one rule for every control that edits a mask — the handles on the
 * picture and the panel's sliders alike: a number whose track has keys takes a
 * key at the frame, and anything else changes the shape itself. So a mask that
 * is not animated behaves exactly as it always did, and one that is animated
 * cannot be edited in a way its own keys would then silently override.
 */
export function withMaskEdit<C extends Keyed>(clip: C, patch: Partial<MaskShape>, frame: number): C {
  if (!clip.mask) return clip
  const at = keyFrame(clip, frame)
  let tracks = clip.keyframes ?? {}
  const shapePatch: Partial<MaskShape> = { ...patch }
  for (const field of MASK_FIELDS) {
    const value = patch[field]
    const property = MASK_TRACK[field]
    if (value === undefined || !(tracks[property]?.length)) continue
    tracks = withKey(tracks, property, at, value, clip.duration)
    delete shapePatch[field]
  }
  return {
    ...clip,
    mask: { ...clip.mask, shape: { ...clip.mask.shape, ...shapePatch } },
    ...(clip.keyframes || Object.keys(tracks).length > 0 ? { keyframes: tracks } : {})
  }
}

/**
 * Turn the mask's animation on, or off.
 *
 * On writes a key for each of the four numbers at the frame, where the shape
 * already is, so nothing moves until something is changed at another frame.
 * Off keeps what is on screen: the shape takes its values at the frame and
 * the four tracks go.
 */
export function withMaskAnimation<C extends Keyed>(clip: C, on: boolean, frame: number): C {
  if (!clip.mask) return clip
  const at = keyFrame(clip, frame)
  if (on) {
    if (isMaskAnimated(clip.keyframes)) return clip
    let tracks = clip.keyframes ?? {}
    for (const field of MASK_FIELDS) {
      tracks = withKey(tracks, MASK_TRACK[field], at, clip.mask.shape[field], clip.duration)
    }
    return { ...clip, keyframes: tracks }
  }
  const shape = maskShapeAt(clip.mask.shape, clip.keyframes, at, clip.duration)
  return { ...clip, mask: { ...clip.mask, shape }, keyframes: withoutMaskKeys(clip.keyframes) }
}

/**
 * The clip's tracks with the mask's taken out — for a mask removed or
 * replaced, whose keys would otherwise steer whatever mask came next.
 */
export function withoutMaskKeys(keyframes: KeyframeTracks | undefined): KeyframeTracks | undefined {
  if (!keyframes) return undefined
  const kept = { ...keyframes }
  for (const field of MASK_FIELDS) delete kept[MASK_TRACK[field]]
  return Object.keys(kept).length > 0 ? kept : undefined
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
