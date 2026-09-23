import type { Clip, MediaAsset, Project } from '../timeline'
import { framesToSeconds } from '../timeline'
import type { MusicAnalysis } from '../automation/cutPlan'
import { buildCutMenu, buildSlots, familyMenu, type Menu, type Slot } from './menu'
import type { Brief, Tone } from './schema'

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

/** The ad's default length when the brief leaves it blank: this, or the music, whichever is shorter. */
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

/** How long the ad is: what the brief asked for, else thirty seconds or the music, whichever is shorter. */
export function adSeconds(draft: Pick<BriefDraft, 'seconds'>, music: MusicChoice | null): number {
  return draft.seconds ?? Math.min(DEFAULT_AD_SECONDS, music ? music.windowMs / 1000 : DEFAULT_AD_SECONDS)
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

export { buildSlots }
