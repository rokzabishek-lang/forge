import type { Tone } from '../schema'
import type { Recipe, RecipeId } from './types'

export * from './types'

/**
 * The five directing recipes (docs/PLAN.md §5.1), as the research described
 * them. Every number is a starting point the eval's ratings tune; every id is
 * checked against its registry by `tests/directorRecipes.test.ts`.
 *
 * Pacing is in BEATS at position p∈[0,1] of the body (not counting the black
 * and the end card). The hero's hold and its floor in seconds are applied by
 * the rhythm engine on top of it.
 */

/** Linear from a to b over p. */
const lerp = (a: number, b: number, p: number): number => a + (b - a) * Math.max(0, Math.min(1, p))

export const WEDDING_HIGHLIGHT: Recipe = {
  id: 'wedding-highlight',
  name: 'Wedding highlight',
  intent: 'Emotional holds on faces, a gentle build, one warm grade — the day, not a sale.',
  forKind: 'weddings, engagements, family events',
  roles: ['hook', 'story', 'cta'],
  // A gentle build: four beats a shot at the start, two by the end.
  pacing: (p) => lerp(4, 2, p),
  tempo: 90,
  hold: { hero: 2.5, heroMinSeconds: 6, faces: 1.5 },
  ending: { blackBeats: 2, endCardSeconds: 3, silence: true },
  moments: { budget: 2, at: ['hero-reveal', 'section'], kinds: ['light-burn', 'depth-push'] },
  treatments: { budget: 0, kinds: [], at: [] },
  sound: { rules: [{ event: 'swell', on: 'hero-reveal' }, { event: 'silence', on: 'before-black' }], maxHits: 0 },
  type: { styles: ['soft-fade', 'clean'], animations: ['fade'], maxCards: 4, endCard: 'names-date' },
  look: 'warm-film',
  transitions: { families: ['light', 'dissolve'], stillsShare: 0.45 },
  moves: { stills: ['in', 'inLeft', 'inRight', 'panLeft', 'panRight', 'hold'], heroMove: 'parallax' },
  speed: { heroSlow: true, ramp: false },
  intensity: 0.4,
  wantsPeople: true
}

export const PRODUCT_REVEAL: Recipe = {
  id: 'product-reveal',
  name: 'Product reveal',
  intent: 'Slow wides and details building to one hero shot, then silence, black, and the name.',
  forKind: 'a product: cosmetics, gadgets, food and drink, fashion items',
  roles: ['hook', 'story', 'product', 'offer', 'cta'],
  // Slow at first, tightening to a beat a shot before the reveal.
  pacing: (p) => (p < 0.5 ? lerp(4, 2, p * 2) : lerp(2, 1, (p - 0.5) * 2)),
  tempo: 100,
  hold: { hero: 3, heroMinSeconds: 4, faces: 1.2 },
  ending: { blackBeats: 4, endCardSeconds: 2.5, silence: true },
  moments: { budget: 2, at: ['hero-reveal', 'section'], kinds: ['zoom-punch', 'depth-push'] },
  treatments: { budget: 0, kinds: [], at: [] },
  sound: { rules: [{ event: 'riser', on: 'hero-reveal' }, { event: 'sub', on: 'hero-reveal' }, { event: 'silence', on: 'before-black' }], maxHits: 1 },
  type: { styles: ['hero', 'cinematic'], animations: ['rise'], maxCards: 3, endCard: 'product-cta' },
  look: 'cool-cine',
  transitions: { families: ['dissolve'], stillsShare: 0.25 },
  moves: { stills: ['hold', 'in'], heroMove: 'push-in' },
  speed: { heroSlow: true, ramp: true },
  intensity: 0.5,
  wantsPeople: false
}

export const ENERGY: Recipe = {
  id: 'energy',
  name: 'Energy',
  intent: 'Accelerating cuts on the beat, hits on the drops, a ramp — sport, launches, hype.',
  forKind: 'sport, fitness, launches, events with a crowd',
  roles: ['hook', 'problem', 'product', 'proof', 'offer', 'cta'],
  // Accelerating: two beats a shot down to half a beat, exponentially.
  pacing: (p) => 2 * Math.pow(0.25, Math.max(0, Math.min(1, p))),
  tempo: 124,
  hold: { hero: 2, heroMinSeconds: 2, faces: 1 },
  ending: { blackBeats: 1, endCardSeconds: 2, silence: false },
  moments: { budget: 3, at: ['drop', 'hero-reveal', 'climax'], kinds: ['whip-blur', 'zoom-punch', 'light-burn'] },
  treatments: { budget: 1, kinds: ['grid'], at: ['drop'] },
  sound: { rules: [{ event: 'hit', on: 'drop' }, { event: 'whoosh', on: 'whip' }], maxHits: 4 },
  type: { styles: ['poster-3d', 'glitch'], animations: ['pop'], maxCards: 5, endCard: 'product-cta' },
  look: 'teal-orange',
  transitions: { families: ['whip', 'zoom', 'glitch'], stillsShare: 0.55 },
  moves: { stills: ['in', 'inLeft', 'inRight', 'inUp', 'inDown'], heroMove: 'push-in' },
  speed: { heroSlow: false, ramp: true },
  intensity: 0.85,
  wantsPeople: false
}

export const TRAILER: Recipe = {
  id: 'trailer',
  name: 'Trailer',
  intent: 'Three acts: slow set-up, rising stakes, a climax into black and the title.',
  forKind: 'films, launches with a story, events with a build-up',
  roles: ['hook', 'story', 'product', 'cta'],
  // Act one slow, act two rising, act three a cut every half beat.
  pacing: (p) => (p < 0.3 ? 4 : p < 0.8 ? lerp(4, 1, (p - 0.3) / 0.5) : 0.5),
  tempo: 100,
  hold: { hero: 2, heroMinSeconds: 3, faces: 1.2 },
  ending: { blackBeats: 2, endCardSeconds: 2, silence: true },
  moments: { budget: 3, at: ['section', 'climax', 'hero-reveal'], kinds: ['light-burn', 'whip-blur', 'zoom-punch'] },
  treatments: { budget: 1, kinds: ['strips'], at: ['climax'] },
  sound: { rules: [{ event: 'riser', on: 'hero-reveal' }, { event: 'braam', on: 'before-black' }, { event: 'hit', on: 'drop' }], maxHits: 3 },
  type: { styles: ['cinematic', 'hollow'], animations: ['zoom-out'], maxCards: 4, endCard: 'title-cta' },
  look: 'bleach-bypass',
  transitions: { families: ['film', 'zoom', 'whip'], stillsShare: 0.4 },
  moves: { stills: ['out', 'outLeft', 'outRight', 'panLeft', 'panRight'], heroMove: 'push-in' },
  speed: { heroSlow: true, ramp: true },
  intensity: 0.7,
  wantsPeople: false
}

export const FASHION: Recipe = {
  id: 'fashion',
  name: 'Fashion / perfume',
  intent: 'Slow, spare, negative space, minimal type — let the picture carry it.',
  forKind: 'fashion, perfume, jewellery, luxury',
  roles: ['hook', 'story', 'product', 'cta'],
  // Slow throughout, five to seven beats, longest in the middle.
  pacing: (p) => 5 + 2 * Math.sin(Math.PI * Math.max(0, Math.min(1, p))),
  tempo: 90,
  hold: { hero: 2, heroMinSeconds: 5, faces: 1.2 },
  ending: { blackBeats: 2, endCardSeconds: 3, silence: true },
  moments: { budget: 1, at: ['hero-reveal'], kinds: ['depth-push'] },
  treatments: { budget: 0, kinds: [], at: [] },
  sound: { rules: [{ event: 'silence', on: 'before-black' }], maxHits: 0 },
  type: { styles: ['hollow-accent', 'clean'], animations: ['fade'], maxCards: 2, endCard: 'product-cta' },
  look: 'faded',
  transitions: { families: ['dissolve', 'smooth'], stillsShare: 0.3 },
  moves: { stills: ['hold', 'panLeft', 'panRight'], heroMove: 'parallax' },
  speed: { heroSlow: true, ramp: false },
  intensity: 0.3,
  wantsPeople: false
}

export const RECIPES: readonly Recipe[] = [WEDDING_HIGHLIGHT, PRODUCT_REVEAL, ENERGY, TRAILER, FASHION]

/** The two recipes built and tuned first (docs/PLAN.md §10.2); the others follow. */
export const FIRST_RECIPES: readonly RecipeId[] = ['wedding-highlight', 'product-reveal']

export function recipeById(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) ?? null
}

/**
 * Words that say a brief is about a wedding, in the languages the niche
 * works in. Matched whole, case ignored.
 */
const WEDDING_WORDS = /\b(wedding|weddings|bride|groom|marriage|married|engagement|reception|sangeet|haldi|mehendi|mehndi|shaadi|vivah|pelli|kalyanam|baraat)\b/i

export function looksLikeWedding(text: string): boolean {
  return WEDDING_WORDS.test(text)
}

/**
 * The recipe when no model chooses — the standard cut's (docs/PLAN.md §5.2),
 * by the brief's tone, the way `paceFor` chooses the pace. A calm brief is a
 * wedding when it says so or when the eyes saw people; otherwise Fashion.
 */
export function recipeForTone(tone: Tone, signals: { briefText: string; peopleInSet: boolean }): Recipe {
  switch (tone) {
    case 'urgent':
    case 'energetic':
    case 'playful':
      return ENERGY
    case 'premium':
      return looksLikeWedding(signals.briefText) ? WEDDING_HIGHLIGHT : PRODUCT_REVEAL
    case 'calm':
      return looksLikeWedding(signals.briefText) || signals.peopleInSet ? WEDDING_HIGHLIGHT : FASHION
  }
}
