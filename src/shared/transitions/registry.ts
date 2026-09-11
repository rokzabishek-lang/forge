/**
 * Transition registry.
 *
 * A transition is a real overlap between two clips on one track plus an effect
 * applied to the *incoming* clip. The compositor already draws a later clip over
 * an earlier one, so nothing new is needed in the render graph — which is also
 * why luma-mask transitions slot in later as "an alpha source" rather than as a
 * second pipeline. See docs/AUTOMATION.md §5.
 */

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

export interface TransitionDef {
  id: string
  label: string
  family: TransitionFamily
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
  /** Mask file for tier 2, relative to the assets root. */
  mask?: string
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
    incoming: (ctx) => [
      `fade=t=in:st=0:d=${ctx.duration.toFixed(4)}:alpha=1`,
      // zoompan runs on the clip's own frames, so d is in frames not seconds.
      `scale=${Math.round(ctx.canvasWidth * 1.15)}:-2`,
      `crop=${ctx.canvasWidth}:${ctx.canvasHeight}`
    ]
  }
]

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
