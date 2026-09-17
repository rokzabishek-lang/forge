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
 * geq expression driving a luma wipe's alpha.
 *
 * At time T the threshold sweeps from below the darkest level to above the
 * brightest, so every pixel flips from transparent to opaque in the order its
 * mask brightness dictates — which is exactly what a luma wipe is. Saturating
 * past the transition length matters: the mask input outlives the wipe, and
 * without saturation the clip would fade back out again.
 */
export function lumaAlphaExpression(duration: number, softness = LUMA_SOFTNESS): string {
  const d = Math.max(0.0001, duration).toFixed(4)
  const s = Math.max(1, softness)
  // progress sweeps 0 -> 1 over the transition, then keeps climbing (clipped).
  return `clip((((T/${d})*(255+${s}) - p(X,Y)) / ${s}) * 255, 0, 255)`
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
  /** Overlay placement expressions; t is timeline seconds, S the clip's start. */
  position?: (ctx: TransitionContext) => { x: string; y: string }
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

/** alpha=1 fades the alpha channel rather than toward black. */
const alphaFadeIn = (ctx: TransitionContext): string[] => [
  `fade=t=in:st=0:d=${ctx.duration.toFixed(4)}:alpha=1`
]

/**
 * Slide the incoming clip in from an edge.
 *
 * `S` is substituted with the clip's timeline start before the expression
 * reaches ffmpeg; after the transition window the clip rests at 0.
 */
function slide(axis: 'x' | 'y', from: number): TransitionDef['position'] {
  return (ctx) => {
    const span = axis === 'x' ? ctx.canvasWidth : ctx.canvasHeight
    const travel = from * span
    const d = ctx.duration.toFixed(4)
    // Ease-out so the slide decelerates instead of arriving at constant speed.
    const progress = `min(1,(t-S)/${d})`
    const eased = `(1-pow(1-${progress},2))`
    const expr = `if(lt(t-S,${d}), ${travel}*(1-${eased}), 0)`
    return axis === 'x' ? { x: expr, y: '0' } : { x: '0', y: expr }
  }
}

export const TRANSITIONS: TransitionDef[] = [
  {
    id: 'dissolve',
    label: 'Dissolve',
    family: 'dissolve',
    tier: 1,
    defaultFrames: 15,
    incoming: alphaFadeIn
  },
  {
    id: 'dissolve-fast',
    label: 'Quick dissolve',
    family: 'dissolve',
    tier: 1,
    defaultFrames: 7,
    incoming: alphaFadeIn
  },
  {
    id: 'slide-left',
    label: 'Slide from right',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    position: slide('x', 1)
  },
  {
    id: 'slide-right',
    label: 'Slide from left',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    position: slide('x', -1)
  },
  {
    id: 'slide-up',
    label: 'Slide from below',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    position: slide('y', 1)
  },
  {
    id: 'slide-down',
    label: 'Slide from above',
    family: 'slide',
    tier: 1,
    defaultFrames: 12,
    position: slide('y', -1)
  },
  {
    id: 'slide-fade',
    label: 'Slide and fade',
    family: 'smooth',
    tier: 1,
    defaultFrames: 14,
    incoming: alphaFadeIn,
    position: slide('x', 0.35)
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    family: 'zoom',
    tier: 1,
    defaultFrames: 12,
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
    incoming: (ctx) => [
      `fade=t=in:st=0:d=${ctx.duration.toFixed(4)}:alpha=1`,
      `scale=trunc(iw*1.15/2)*2:-2`,
      `crop=iw/1.15:ih/1.15`
    ]
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
