import { describe, expect, it } from 'vitest'
import { DRAWABLE_MOMENTS, FIRST_RECIPES, RECIPES, looksLikeWedding, recipeById, recipeForTone } from '@shared/director/recipes'
import { TEXT_STYLES } from '@shared/render/textStyle'
import { TEXT_ANIMATIONS } from '@shared/render/textAnimation'
import { LOOKS } from '@shared/render/looks'
import { TRANSITIONS } from '@shared/transitions/registry'
import { TONES } from '@shared/director/schema'

/**
 * The directing recipes (docs/PLAN.md §5.1) against the registries they name.
 * A recipe naming a style, look or family that does not exist would fail at
 * the moment a user's ad needed it; here it fails the suite instead.
 */

const MOVES = ['in', 'out', 'inLeft', 'inRight', 'inUp', 'inDown', 'outLeft', 'outRight', 'panLeft', 'panRight', 'panUp', 'panDown', 'hold']
const FAMILIES = new Set(TRANSITIONS.map((t) => t.family).concat(['whip', 'glitch', 'light', 'wipe', 'film']))

describe.each(RECIPES.map((r) => [r.id, r] as const))('recipe %s', (_id, recipe) => {
  it('names only styles, animations and a look that exist', () => {
    const styles = new Set(TEXT_STYLES.map((s) => s.id))
    const animations = new Set(TEXT_ANIMATIONS.map((a) => a.id))
    for (const s of recipe.type.styles) expect(styles.has(s), s).toBe(true)
    for (const a of recipe.type.animations) expect(animations.has(a), a).toBe(true)
    if (recipe.look !== 'none') expect(LOOKS.map((l) => l.id)).toContain(recipe.look)
    expect(recipe.type.styles.length).toBeGreaterThan(0)
    expect(recipe.type.animations.length).toBeGreaterThan(0)
  })

  it('names only transition families and moves that exist', () => {
    for (const f of recipe.transitions.families) expect(FAMILIES.has(f), f).toBe(true)
    for (const m of recipe.moves.stills) expect(MOVES, m).toContain(m)
    expect(recipe.transitions.stillsShare).toBeGreaterThan(0)
    expect(recipe.transitions.stillsShare).toBeLessThanOrEqual(0.6)
  })

  it('places only moments C4 draws, within its budget', () => {
    for (const k of recipe.moments.kinds) expect(DRAWABLE_MOMENTS, k).toContain(k)
    expect(recipe.moments.kinds.length).toBeGreaterThanOrEqual(recipe.moments.budget)
    expect(recipe.moments.budget).toBeLessThanOrEqual(3)
    expect(recipe.treatments.kinds.length).toBeGreaterThanOrEqual(recipe.treatments.budget)
  })

  it('paces in whole-number-ish beats, always positive, over the whole body', () => {
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const beats = recipe.pacing(p)
      expect(Number.isFinite(beats)).toBe(true)
      expect(beats).toBeGreaterThan(0.25)
      expect(beats).toBeLessThanOrEqual(8)
    }
    // Out of range is clamped, never NaN or negative.
    expect(recipe.pacing(-1)).toBeGreaterThan(0)
    expect(recipe.pacing(2)).toBeGreaterThan(0)
  })

  it('reserves an ending that fits inside ten seconds of music at its own tempo', () => {
    const beat = 60 / recipe.tempo
    const ending = recipe.ending.blackBeats * beat + recipe.ending.endCardSeconds
    expect(recipe.ending.endCardSeconds).toBeGreaterThanOrEqual(1.5)
    expect(ending).toBeLessThan(10 * 0.5)
  })

  it('holds the hero longest, and a wedding hero for six seconds', () => {
    expect(recipe.hold.hero).toBeGreaterThanOrEqual(recipe.hold.faces)
    expect(recipe.hold.hero).toBeGreaterThan(1)
    if (recipe.id === 'wedding-highlight') expect(recipe.hold.heroMinSeconds).toBe(6)
    expect(recipe.intensity).toBeGreaterThanOrEqual(0)
    expect(recipe.intensity).toBeLessThanOrEqual(1)
  })
})

describe('choosing a recipe without a model', () => {
  it('every tone has one', () => {
    for (const tone of TONES) expect(recipeForTone(tone, { briefText: '', peopleInSet: false })).toBeTruthy()
  })

  it('a calm or premium brief that says wedding is a wedding, in any of the niche’s words', () => {
    expect(recipeForTone('calm', { briefText: 'Priya & Arjun — the wedding film', peopleInSet: false }).id).toBe('wedding-highlight')
    expect(recipeForTone('premium', { briefText: 'Sravani & Karthik pelli video', peopleInSet: false }).id).toBe('wedding-highlight')
    expect(recipeForTone('calm', { briefText: 'Noir 9 perfume', peopleInSet: false }).id).toBe('fashion')
    expect(recipeForTone('calm', { briefText: 'a family day', peopleInSet: true }).id).toBe('wedding-highlight')
    expect(recipeForTone('premium', { briefText: 'Aura serum', peopleInSet: true }).id).toBe('product-reveal')
    expect(recipeForTone('urgent', { briefText: 'wedding sale', peopleInSet: true }).id).toBe('energy')
  })

  it('matches whole words, not letters inside other words', () => {
    expect(looksLikeWedding('the bridegroom arrives')).toBe(false)
    expect(looksLikeWedding('Mehendi night')).toBe(true)
    expect(looksLikeWedding('Groomed dogs')).toBe(false)
  })

  it('the first two to build are the wedding and the product reveal', () => {
    expect(FIRST_RECIPES.map((id) => recipeById(id)!.name)).toEqual(['Wedding highlight', 'Product reveal'])
    expect(recipeById('nope')).toBeNull()
  })
})
