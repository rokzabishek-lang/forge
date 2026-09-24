import type { MotionMove } from '../../timeline'
import type { TransitionFamily } from '../../transitions/registry'

/**
 * A directing recipe — the grammar for one kind of ad (docs/PLAN.md §5.1).
 *
 * The model picks the recipe, casts the photos, marks the hero and writes the
 * words; the recipe decides everything that is timing or taste: how the shots
 * shorten towards the peak, how long the hero holds, where the black falls,
 * which two or three moments an ad gets and where, which sounds fire on which
 * cut, the type, the one grade. A bad answer still lands inside these rules —
 * which is the point of writing them down as data.
 *
 * Every id a recipe names (text styles, animations, looks, transition families,
 * moves) is checked against its registry by `tests/directorRecipes.test.ts`.
 * They are strings here rather than derived unions: `as const` on the text and
 * look registries would make every nested array in them readonly and ripple
 * into the pickers, for a check the test already makes.
 */

export type RecipeId = 'wedding-highlight' | 'product-reveal' | 'energy' | 'trailer' | 'fashion'

/** The designed moments C4 draws (docs/PLAN.md §7). `kinetic-type` waits for §11's gate. */
export type MomentKind = 'zoom-punch' | 'whip-blur' | 'light-burn' | 'depth-push' | 'kinetic-type'
/** The moment kinds C4 builds; a recipe naming another is repaired to its first of these. */
export const DRAWABLE_MOMENTS: readonly MomentKind[] = ['zoom-punch', 'whip-blur', 'light-burn', 'depth-push']

/** Single-slot treatments the app already makes (grid.ts, strips.ts, paper.ts, onePhoto.ts). */
export type TreatmentKind = 'grid' | 'strips' | 'clipping' | 'framing'

/** Where a moment or a treatment may go. */
export type Place = 'hero-reveal' | 'drop' | 'climax' | 'section'

export type SoundEvent = 'riser' | 'swell' | 'hit' | 'braam' | 'sub' | 'whoosh' | 'silence'
export type SoundCue = 'hero-reveal' | 'drop' | 'whip' | 'before-black'

export interface SoundRule {
  event: SoundEvent
  on: SoundCue
}

/**
 * What a shot does in the ad. `spine@1` had one sales skeleton for every ad —
 * hook, problem, product, proof, offer, cta — and C0 measured it forced onto a
 * wedding ("Moments fade quickly" as a wedding film's problem, docs/EVAL.md).
 * Each recipe now names the roles it has; `story` is the wedding's and the
 * reveal's middle.
 */
export const ROLES2 = ['hook', 'story', 'problem', 'product', 'proof', 'offer', 'cta'] as const
export type Role2 = (typeof ROLES2)[number]

export type HeroMove = 'push-in' | 'hold' | 'parallax'
export type StillMove = MotionMove | 'hold'
export type EndCard = 'names-date' | 'product-cta' | 'title-cta'

export interface Recipe {
  id: RecipeId
  name: string
  /** One line: shown in the panel and to the model. */
  intent: string
  /** The kind of shoot it is for, so the model can tell recipes apart. */
  forKind: string
  /** The roles this kind of ad has, in the order they come. */
  roles: Role2[]
  /**
   * Target shot length in BEATS at position p∈[0,1] of the body. The rhythm
   * engine multiplies by the holds, fits the window and snaps to legal cuts.
   */
  pacing: (p: number) => number
  /** Beats per minute to pace by when there is no music. */
  tempo: number
  hold: {
    /** The hero's target is `pacing × hero`, then raised to `heroMinSeconds`. */
    hero: number
    heroMinSeconds: number
    faces: number
  }
  /**
   * `blackBeats` in beats (a bar is four); `silence` only says whether the
   * music mutes over the black — when it does, from the last body cut through
   * the black, never a length of its own.
   */
  ending: { blackBeats: number; endCardSeconds: number; silence: boolean }
  moments: { budget: number; at: Place[]; kinds: MomentKind[] }
  treatments: { budget: 0 | 1 | 2; kinds: TreatmentKind[]; at: Place[] }
  sound: { rules: SoundRule[]; maxHits: number }
  type: { styles: string[]; animations: string[]; maxCards: number; endCard: EndCard }
  /** A look id from render/looks.ts, or none. */
  look: string | 'none'
  transitions: { families: TransitionFamily[]; stillsShare: number }
  moves: { stills: StillMove[]; heroMove: HeroMove }
  speed: { heroSlow: boolean; ramp: boolean }
  /** 0..1 — the coherence dial's default. */
  intensity: number
  /** The hero must have people in it (the gate's `wantsPeople`). */
  wantsPeople: boolean
}
