/**
 * Transition registry.
 *
 * A transition is a real overlap between two clips on one track plus an effect
 * applied to the *incoming* clip. The compositor already draws a later clip over
 * an earlier one, so nothing new is needed in the render graph — which is also
 * why luma-mask transitions slot in later as "an alpha source" rather than as a
 * second pipeline. See docs/AUTOMATION.md §5.
 */

import type { MaskTag } from './classify'

export type TransitionFamily =
  | 'dissolve'
  | 'slide'
  | 'zoom'
  | 'whip'
  | 'glitch'
  | 'light'
  | 'wipe'
  | 'film'
  | 'smooth'

export interface TransitionContext {
  /** Length of the overlap, in seconds. */
  duration: number
  canvasWidth: number
  canvasHeight: number
}

/**
 * Softness of a luma wipe's edge, in luma levels.
 *
 * A hard threshold gives a jagged, aliased boundary that crawls; a band of
 * partial alpha around it reads as a clean moving edge. Too wide and the wipe
 * becomes an unfocused dissolve.
 */
export const LUMA_SOFTNESS = 28

/**
 * The straight line a luma wipe's alpha follows, in normalised units.
 *
 * At progress p a pixel of brightness `lum` has alpha `slope*lum + offset`,
 * clamped to [0,1] — so the threshold `p*(255+s)` sweeps from below the darkest
 * level to above the brightest and every pixel flips in the order its mask
 * brightness dictates, with a band of width `s` softening the boundary. That is
 * exactly what a luma wipe is.
 *
 * This is the single source for the sum. `lumaAlphaExpression` spells it as a
 * geq for ffmpeg and `lumaAlpha` evaluates it for the preview; the shape of the
 * wipe therefore cannot differ between the two, only its resolution can.
 */
export function lumaAlphaRamp(
  progress: number,
  softness = LUMA_SOFTNESS
): { slope: number; offset: number } {
  const s = Math.max(1, softness)
  return { slope: -255 / s, offset: (progress * (255 + s)) / s }
}

/** The ramp evaluated for one pixel: mask brightness and alpha both 0-255. */
export function lumaAlpha(progress: number, luma: number, softness = LUMA_SOFTNESS): number {
  const { slope, offset } = lumaAlphaRamp(progress, softness)
  return Math.max(0, Math.min(255, (slope * (luma / 255) + offset) * 255))
}

/**
 * Rec.709 luma weights. ffmpeg's `format=gray` is Rec.601, and the difference
 * is unreachable rather than tolerated: a wipe mask is greyscale by definition,
 * so R=G=B and every weighting returns the same luma.
 */
const LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722] as const

/**
 * The same ramp as an SVG `feColorMatrix`, for the preview's stencil.
 *
 * The canvas has no luma-to-alpha operator, but `feColorMatrix` writes alpha
 * from a weighted sum of RGB plus a constant — which is precisely the straight
 * line above, so the wipe runs on the GPU rather than as a per-pixel loop over
 * an ImageData sixty times a second. RGB is forced to white and only the alpha
 * row carries the ramp, so the result is a pure stencil.
 *
 * Here rather than beside the canvas code because it is a third spelling of one
 * formula, and the two that lived apart are exactly the two that drifted.
 */
export function lumaAlphaMatrix(progress: number, softness = LUMA_SOFTNESS): string {
  const { slope, offset } = lumaAlphaRamp(progress, softness)
  const row = LUMA_WEIGHTS.map((w) => (slope * w).toFixed(6)).join(' ')
  return `0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${row} 0 ${offset.toFixed(6)}`
}

/**
 * geq expression driving a luma wipe's alpha.
 *
 * Saturating past the transition length matters: the mask input outlives the
 * wipe, and without saturation the clip would fade back out again — which is
 * why the expression clamps rather than the caller clamping `T/d`.
 */
export function lumaAlphaExpression(duration: number, softness = LUMA_SOFTNESS): string {
  const d = Math.max(0.0001, duration).toFixed(4)
  const s = Math.max(1, softness)
  // progress sweeps 0 -> 1 over the transition, then keeps climbing (clipped).
  return `clip((((T/${d})*(255+${s}) - p(X,Y)) / ${s}) * 255, 0, 255)`
}

/**
 * What a transition does to the incoming clip at one moment, for the preview.
 *
 * Every field is the preview's half of something the render already does, and
 * the pair is built by one factory below so they cannot drift:
 *
 * | field | the render's half |
 * |---|---|
 * | `alpha` | `fade=t=in:alpha=1` |
 * | `dx`, `dy` | the `overlay` position expression, in canvas pixels |
 * | `scale` | the incoming chain's `scale`+`crop` punch-in |
 *
 * A luma wipe has none of these: it is a stencil, and the draw loop builds it
 * from `mask` and `lumaAlphaRamp` instead.
 */
export interface TransitionPreview {
  /** Multiplied into the layer's opacity. 1 is fully visible. */
  alpha: number
  /** Offset FROM the clip's resting box, in canvas pixels. */
  dx: number
  dy: number
  /** Centred zoom on the source rectangle. 1 is untouched. */
  scale: number
}

/** A clip with no transition, and every transition once it has finished. */
export const AT_REST: TransitionPreview = { alpha: 1, dx: 0, dy: 0, scale: 1 }

/**
 * The transition's state at `progress` (0 at the cut, 1 when it has landed).
 *
 * Progress is clamped rather than trusted: every expression below rests once it
 * reaches 1, and a preview that kept extrapolating would slide the clip back
 * off the canvas the moment the playhead passed the transition.
 */
export function previewAt(
  transition: TransitionDef | null | undefined,
  progress: number,
  ctx: TransitionContext
): TransitionPreview {
  if (!transition?.preview) return AT_REST
  const p = Math.max(0, Math.min(1, progress))
  return { ...AT_REST, ...transition.preview(p, ctx) }
}

export interface TransitionDef {
  id: string
  label: string
  family: TransitionFamily
  /**
   * What the mask actually does, measured from its pixels.
   *
   * The filename is the only other description a mask has, so without these the
   * library's 120 grid reveals are unfindable unless you already know one is
   * called `luminous_boxes_17`. See shared/transitions/classify.
   */
  tags?: MaskTag[]
  /** 1 = plain ffmpeg. 2 = needs the Chromium frame server or a mask. */
  tier: 1 | 2
  defaultFrames: number
  /**
   * Filters applied to the incoming clip BEFORE its timeline offset is applied,
   * so times are relative to the clip's own start.
   */
  incoming?: (ctx: TransitionContext) => string[]
  /**
   * Overlay OFFSETS from the clip's resting box; t is timeline seconds, S the
   * clip's start. The renderer adds them to the box rather than replacing it,
   * so a transition on a picture-in-picture slides that picture rather than
   * teleporting it to the corner of the canvas.
   */
  position?: (ctx: TransitionContext) => { x: string; y: string }
  /**
   * The same effect, evaluated for the canvas preview.
   *
   * Written beside `incoming` and `position` and built from the same numbers,
   * because the preview and the export disagreeing is worse than the preview
   * showing nothing: it teaches the wrong timing. Absent means the transition
   * has nothing a canvas can draw from a formula — which for a luma wipe is
   * true, and the draw loop builds those from `mask` and `lumaAlphaRamp`.
   */
  preview?: (progress: number, ctx: TransitionContext) => Partial<TransitionPreview>
  /**
   * Luma mask, relative to the assets root.
   *
   * Masks stay on tier 1: alphamerge with a geq-animated mask is plain ffmpeg,
   * so 405 extra transitions cost nothing beyond one more input per wipe.
   */
  mask?: string
  /** Edge softness in luma levels; only meaningful with a mask. */
  softness?: number
}

/**
 * One effect, in both spellings.
 *
 * Everything below is built as one of these so that the filters ffmpeg runs and
 * the numbers the canvas draws come out of the same function. A transition is
 * then a combination of them, never a pair of independent implementations that
 * happen to have been written to match — which is the arrangement that let the
 * preview fade EVERY transition, slides and wipes included, for as long as the
 * preview has existed.
 */
type Effect = Pick<TransitionDef, 'incoming' | 'position' | 'preview'>

/** Both effects at once: filters concatenated, preview terms merged. */
function both(a: Effect, b: Effect): Effect {
  return {
    incoming: (ctx) => [...(a.incoming?.(ctx) ?? []), ...(b.incoming?.(ctx) ?? [])],
    ...(a.position ?? b.position ? { position: a.position ?? b.position } : {}),
    preview: (progress, ctx) => ({
      ...a.preview?.(progress, ctx),
      ...b.preview?.(progress, ctx)
    })
  }
}

/** alpha=1 fades the alpha channel rather than toward black. */
const fadeIn: Effect = {
  incoming: (ctx) => [`fade=t=in:st=0:d=${ctx.duration.toFixed(4)}:alpha=1`],
  // `fade` walks its alpha linearly from 0 to 1 across `d`, and holds at 1.
  preview: (progress) => ({ alpha: progress })
}

/**
 * Slide the incoming clip in from an edge.
 *
 * `S` is substituted with the clip's timeline start before the expression
 * reaches ffmpeg; after the transition window the offset rests at 0, which is
 * the clip's own box rather than the corner of the canvas.
 *
 * The travel is `from × span × (1-p)²` — an ease-out, so the slide decelerates
 * instead of arriving at constant speed. ffmpeg gets it as `travel*(1-eased)`
 * where `eased = 1-(1-p)²`, which is the same number written the way the curve
 * is usually named. `tests/transitionPreview.test.ts` evaluates the expression
 * and holds the two to within a pixel.
 */
function slide(axis: 'x' | 'y', from: number): Effect {
  return {
    position: (ctx) => {
      const travel = from * (axis === 'x' ? ctx.canvasWidth : ctx.canvasHeight)
      const d = ctx.duration.toFixed(4)
      const progress = `min(1,(t-S)/${d})`
      const eased = `(1-pow(1-${progress},2))`
      const expr = `if(lt(t-S,${d}), ${travel}*(1-${eased}), 0)`
      return axis === 'x' ? { x: expr, y: '0' } : { x: '0', y: expr }
    },
    preview: (progress, ctx) => {
      const travel = from * (axis === 'x' ? ctx.canvasWidth : ctx.canvasHeight)
      // `+ 0` only to turn -0 into 0, which a leftward slide produces at rest.
      // Harmless on a canvas, and a trap in any equality check downstream.
      const offset = travel * (1 - progress) ** 2 + 0
      return axis === 'x' ? { dx: offset } : { dy: offset }
    }
  }
}

/**
 * A punch-in on the incoming clip.
 *
 * Note what this is NOT: the zoom does not animate and does not end with the
 * transition. `scale` then `crop` is a constant enlargement applied to the
 * clip's whole chain, so "Zoom in" leaves the shot 15% tighter for its entire
 * length. That is what the render has always done, and the preview now shows
 * it rather than hiding it behind a dissolve. See docs/FIX.md A2.
 */
function punchIn(factor: number): Effect {
  return {
    /*
     * Sized against the stream it is handed, never against the canvas.
     *
     * A transition's filters run inside the clip's own chain, where the stream
     * is the clip's box — which equals the canvas only for a clip that fills
     * the frame. Written in canvas pixels, this blew a picture-in-picture up to
     * full size the moment it was zoomed on, and it broke the renderer's
     * arithmetic outright for a turned clip, whose frame is grown to keep its
     * corners: the plan offsets the overlay by half that growth, and a clip that
     * came out canvas-sized instead landed half the growth away from where it
     * belonged.
     *
     * `iw`/`ih` are whatever arrives, so both cases are simply right. The
     * trunc-to-even keeps the intermediate width legal for the yuva420p chain.
     */
    incoming: () => [`scale=trunc(iw*${factor}/2)*2:-2`, `crop=iw/${factor}:ih/${factor}`],
    preview: () => ({ scale: factor })
  }
}

export const TRANSITIONS: TransitionDef[] = [
  {
    id: 'dissolve',
    label: 'Dissolve',
    family: 'dissolve',
    tier: 1,
    defaultFrames: 15,
    ...fadeIn
  },
  {
    id: 'dissolve-fast',
    label: 'Quick dissolve',
    family: 'dissolve',
    tier: 1,
    defaultFrames: 7,
    ...fadeIn
  },
  {
    id: 'slide-left',
    label: 'Slide from right',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    ...slide('x', 1)
  },
  {
    id: 'slide-right',
    label: 'Slide from left',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    ...slide('x', -1)
  },
  {
    id: 'slide-up',
    label: 'Slide from below',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    ...slide('y', 1)
  },
  {
    id: 'slide-down',
    label: 'Slide from above',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    ...slide('y', -1)
  },
  {
    id: 'slide-fade',
    label: 'Slide and fade',
    family: 'smooth',
    tier: 1,
    defaultFrames: 14,
    ...both(fadeIn, slide('x', 0.35))
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    family: 'zoom',
    tier: 1,
    defaultFrames: 12,
    ...both(fadeIn, punchIn(1.15))
  }
]

/**
 * Build transition entries from catalog mask files.
 *
 * The library is browsed as a curated set of families rather than a flat list of
 * 405 — nobody chooses from 405. Each mask becomes a member of a family inferred
 * from its filename, and the picker offers families.
 */
export function transitionsFromMasks(
  masks: { id: string; name: string; file: string; tags?: MaskTag[] }[]
): TransitionDef[] {
  return masks.map((mask) => ({
    id: mask.id,
    label: mask.name,
    family: familyForMaskName(mask.name),
    tier: 1 as const,
    defaultFrames: 14,
    mask: mask.file,
    ...(mask.tags ? { tags: mask.tags } : {})
  }))
}

/** Every transition carrying a tag, for the picker's filter row. */
export function transitionsWithTag(all: TransitionDef[], tag: MaskTag): TransitionDef[] {
  return all.filter((t) => t.tags?.includes(tag))
}

export function availableTags(all: TransitionDef[]): MaskTag[] {
  const seen = new Set<MaskTag>()
  for (const t of all) for (const tag of t.tags ?? []) seen.add(tag)
  return [...seen]
}

/** Group masks by what their filenames suggest, so the picker stays navigable. */
export function familyForMaskName(name: string): TransitionFamily {
  const text = name.toLowerCase()
  if (/ripple|wave|water|liquid/.test(text)) return 'smooth'
  if (/glitch|noise|static|digital|pixel/.test(text)) return 'glitch'
  if (/burn|flare|light|glow|flash|lens/.test(text)) return 'light'
  if (/film|grain|reel|burn/.test(text)) return 'film'
  if (/zoom|blur|radial/.test(text)) return 'zoom'
  if (/whip|swipe|dash|speed/.test(text)) return 'whip'
  if (/square|bar|box|grid|shape|circle|star|heart/.test(text)) return 'wipe'
  return 'dissolve'
}

export const TRANSITIONS_BY_ID: Record<string, TransitionDef> = Object.fromEntries(
  TRANSITIONS.map((t) => [t.id, t])
)

export function transitionById(id: string): TransitionDef | null {
  return TRANSITIONS_BY_ID[id] ?? null
}

/** Families that currently have at least one usable member. */
export function availableFamilies(): TransitionFamily[] {
  return [...new Set(TRANSITIONS.map((t) => t.family))]
}

export function transitionsInFamily(family: TransitionFamily): TransitionDef[] {
  return TRANSITIONS.filter((t) => t.family === family)
}

/**
 * Pick a member of a family, varying by index so the same wipe does not repeat
 * at every cut. Deterministic: the same index always yields the same choice.
 */
export function pickFromFamily(family: TransitionFamily, index: number): TransitionDef | null {
  const members = transitionsInFamily(family)
  if (members.length === 0) return null
  return members[Math.abs(index) % members.length]
}
