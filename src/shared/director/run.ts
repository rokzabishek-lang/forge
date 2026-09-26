import type { Clip, MediaAsset, Project } from '../timeline'
import { framesToSeconds } from '../timeline'
import type { MusicAnalysis } from '../automation/cutPlan'
import type { Problem } from './conforms'
import { buildCutMenu, buildSlots, familyMenu, type Menu, type Slot } from './menu'
import { MAX_SEGMENTS, type Brief, type Tone } from './schema'
import { RECIPES, recipeForTone, type Recipe } from './recipes'
import { layout, rhythmGrid, type Grid, type ShotIntent } from './rhythm'
import type { Menu2 } from './schema2'
import { validateSpine2 } from './validate2'
import { baselineSpine2 } from './baseline2'
import { composeAd, type Composed } from './compose'

/**
 * The pure half of a Director run: what the music is, how long the ad is, the
 * menu, and the brief as the model will see it.
 *
 * `store.ts` `direct()` is the runner — it clears the last run, asks, falls
 * back to the standard cut, applies and bakes — and it lives in the renderer,
 * which nothing outside the renderer can import. Everything it decides BEFORE
 * it asks is here instead, so the Director eval (tests/eval/) builds its
 * requests with the app's own code rather than with a copy of it that could
 * drift. Two places computing the same menu is two places to disagree — the
 * lesson apply.ts already states about layout.
 */

/** The brief as the panel holds it: `seconds: null` is "the default", blank fields fill in from the product. */
export interface BriefDraft {
  product: string
  benefit: string
  audience: string
  tone: Tone
  cta: string
  seconds: number | null
  language: string
}

/** The ad's default length when the brief leaves it blank and no recipe says otherwise: this, or the music, whichever is shorter. */
export const DEFAULT_AD_SECONDS = 30
/** The call to action when the brief leaves it blank. */
export const DEFAULT_CTA = 'Shop now'
export const DEFAULT_LANGUAGE = 'English'

export interface MusicChoice {
  clip: Clip
  asset: MediaAsset
  /** How long the music clip is on the timeline — the authority on the window (menu.ts explains). */
  windowMs: number
  /** The part of the FILE the clip plays, for the beat analysis. */
  startMs: number
  endMs: number
}

/**
 * The music the ad is cut to: the first clip on an audio track whose asset has
 * sound. The same rule the reel uses.
 */
export function musicFor(project: Project): MusicChoice | null {
  const fps = project.settings.fps
  const clip = project.clips.find((c) => {
    const track = project.tracks.find((t) => t.id === c.trackId)
    const asset = project.assets.find((a) => a.id === c.assetId)
    return track?.kind === 'audio' && asset?.hasAudio
  })
  if (!clip) return null
  const asset = project.assets.find((a) => a.id === clip.assetId)
  if (!asset) return null
  const startMs = framesToSeconds(clip.inPoint, fps) * 1000
  const windowMs = framesToSeconds(clip.duration, fps) * 1000
  return { clip, asset, windowMs, startMs, endMs: startMs + windowMs }
}

/**
 * How long the ad is: what the brief asked for, else the expected recipe's
 * default — sixty seconds for a wedding teaser, thirty otherwise — or the
 * music, whichever is shorter.
 */
export function adSeconds(
  draft: Pick<BriefDraft, 'seconds'>,
  music: MusicChoice | null,
  recipe?: Pick<Recipe, 'defaultSeconds'> | null
): number {
  const preferred = recipe?.defaultSeconds ?? DEFAULT_AD_SECONDS
  return draft.seconds ?? Math.min(preferred, music ? music.windowMs / 1000 : preferred)
}

/**
 * The recipe an ad is expected to be BEFORE anything is seen: the pinned one,
 * or the tone's from the brief's own words. The length has to be known before
 * the model is asked, so it cannot wait for the model's choice; and the eyes
 * have not run yet, so a calm brief that only its pictures reveal as a wedding
 * keeps the thirty-second default.
 */
export function expectedRecipe(draft: Pick<BriefDraft, 'product' | 'benefit' | 'audience' | 'cta' | 'tone'>, pinned: Recipe | null): Recipe {
  return pinned ?? recipeForTone(draft.tone, { briefText: [draft.product, draft.benefit, draft.audience, draft.cta].join(' '), peopleInSet: false })
}

/** The brief as the model sees it: trimmed, with the blanks filled in. */
export function briefFor(draft: BriefDraft, seconds: number): Brief {
  const product = draft.product.trim()
  return {
    product,
    benefit: draft.benefit.trim() || product,
    audience: draft.audience.trim(),
    tone: draft.tone,
    cta: draft.cta.trim() || DEFAULT_CTA,
    seconds,
    language: draft.language.trim() || DEFAULT_LANGUAGE
  }
}

/** The menu for one run, given the beat analysis (null without music or without the sidecar). */
export function menuFor(
  project: Project,
  slots: Slot[],
  music: MusicChoice | null,
  analysis: MusicAnalysis | null,
  catalogue: { id: string; family: string }[],
  seconds: number
): Menu {
  const fps = project.settings.fps
  return {
    slots,
    cuts: buildCutMenu(analysis, {
      fps,
      seconds,
      offsetFrames: music?.clip.start ?? 0,
      ...(music ? { windowMs: music.windowMs } : {})
    }),
    families: familyMenu(catalogue),
    seconds,
    fps
  }
}

/* ---------------------------------------------------------------- spine@2 */

/**
 * The beats an ad is cut on, for whichever recipe ends up directing it.
 *
 * A function rather than a grid because the recipe is not known until the
 * model has answered, and with no music the grid IS the recipe's tempo.
 */
export function gridsFor(
  project: Project,
  music: MusicChoice | null,
  analysis: MusicAnalysis | null,
  seconds: number
): (recipe: Recipe) => Grid {
  const fps = project.settings.fps
  return (recipe) =>
    rhythmGrid(analysis, {
      fps,
      seconds,
      offsetFrames: music?.clip.start ?? 0,
      ...(music ? { windowMs: music.windowMs } : {}),
      tempo: recipe.tempo
    })
}

/**
 * How many shots the music holds under a recipe, asked of the rhythm engine
 * itself: the most it keeps out of what there is, and the fewest that still
 * fill the ad — fewer than that and it ends early (MAX_STRETCH).
 */
export function holdsFor(recipe: Recipe, grid: Grid, available: number): { min: number; max: number } {
  const stills = (k: number): ShotIntent[] =>
    Array.from({ length: k }, (_, i) => ({
      slotId: `s${i}`, kind: 'image', footageFrames: null, weight: 'normal', face: false, hero: i === Math.floor(k / 2), headline: ''
    }))
  const all = layout(recipe, grid, stills(Math.max(1, Math.min(MAX_SEGMENTS, available))))
  const max = Math.max(1, all.shots.length)
  for (let k = 1; k < max; k++) if (layout(recipe, grid, stills(k)).endFrame >= all.endFrame) return { min: k, max }
  return { min: max, max }
}

/**
 * The `spine@2` menu (docs/PLAN.md §5.2): the gated slots, the recipes on
 * offer — all of them, or the one the user pinned — the tone's recipe for
 * when the model's choice cannot be used, the gate's heroes, and the music
 * as the sentence the prompt gives it.
 */
export function menu2For(
  project: Project,
  gated: { slots: Slot[]; heroCandidates: string[] },
  grids: (recipe: Recipe) => Grid,
  brief: Brief,
  options: { pinned?: Recipe | null } = {}
): Menu2 {
  const fps = project.settings.fps
  const peopleInSet = gated.slots.some((s) => s.look !== undefined && s.look.people !== 'none')
  const fallback =
    options.pinned ?? recipeForTone(brief.tone, { briefText: [brief.product, brief.benefit, brief.audience, brief.cta].join(' '), peopleInSet })
  const grid = grids(fallback)
  const drops = [...grid.structural.entries()]
    .filter(([, s]) => s.reason === 'drop')
    .map(([frame]) => (frame - grid.start) / fps)
    .sort((a, b) => a - b)
  return {
    slots: gated.slots,
    recipes: options.pinned ? [options.pinned] : [...RECIPES],
    fallback,
    heroCandidates: gated.heroCandidates,
    fps,
    seconds: brief.seconds,
    bpm: (60 * fps) / grid.beatFrames,
    holds: holdsFor(fallback, grid, gated.slots.length),
    drops
  }
}

export interface Settled2 {
  composed: Composed
  /** The standard cut was built because the model's plan could not be used. */
  baseline: boolean
  /** Why the model's plan could not be used, when it could not. */
  rejected: string | null
  problems: Problem[]
}

/**
 * The model's answer as the ad that lands: validated and timed, or — when it
 * cannot be used — the standard cut, validated and timed the same way. Never
 * nothing. The app's `direct()` and the Director eval both settle an answer
 * here, so what the eval scores is what the user would have got.
 */
export function settle2(
  answer: { value: unknown; truncated: boolean } | { error: string },
  menu: Menu2,
  brief: Brief,
  grids: (recipe: Recipe) => Grid,
  extras: Parameters<typeof composeAd>[4] = {}
): Settled2 {
  const verdict = 'error' in answer ? { rejected: answer.error, problems: [] } : validateSpine2(answer.value, menu, { truncated: answer.truncated })
  if (!('rejected' in verdict)) {
    const composed = composeAd(verdict.plan, verdict.recipe, menu, grids(verdict.recipe), extras)
    return { composed, baseline: false, rejected: null, problems: [...verdict.problems, ...composed.problems] }
  }
  // The pinned recipe, when there is one, is the menu's fallback — so the standard cut honours it too.
  const standard = validateSpine2(baselineSpine2(brief, menu), menu)
  if ('rejected' in standard) throw new Error(`Even the standard cut could not be laid out: ${standard.rejected}`)
  const composed = composeAd(standard.plan, standard.recipe, menu, grids(standard.recipe), extras)
  return { composed, baseline: true, rejected: verdict.rejected, problems: [...verdict.problems, ...standard.problems, ...composed.problems] }
}

export { buildSlots }
