import type { Brief } from './schema'
import { MAX_SEGMENTS } from './schema'
import type { Recipe, Role2 } from './recipes'
import { movesOf, type Menu2, type Shot2, type SpinePlan2 } from './schema2'

/**
 * The standard cut under `spine@2` — recipe default casting (docs/PLAN.md §5.2).
 *
 * What lands when there is no model, or its plan cannot be used. It always
 * validates, and it is a DIRECTED ad now rather than a beat-grid contact
 * sheet: the recipe (the tone's, unless the user pinned one) paces it, the
 * gate's best candidate is the hero and holds, the moves come from the
 * recipe's list in turn, and the copy is the brief's own words — the product
 * on the hook, the call to action on the last shot. Headline length is checked
 * after timing, as for any plan (compose.ts).
 */

/** Roles for n shots from a recipe's roles: the first is the hook, the last its last, the middle its middle. */
function rolesFor(recipe: Recipe, n: number): Role2[] {
  const roles = recipe.roles
  if (n === 1) return [roles[0]]
  const middle = roles.slice(1, -1)
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return roles[0]
    if (i === n - 1) return roles[roles.length - 1]
    return middle.length > 0 ? middle[Math.min(middle.length - 1, Math.floor(((i - 1) * middle.length) / Math.max(1, n - 2)))] : roles[0]
  })
}

export function baselineSpine2(brief: Brief, menu: Menu2, pinned?: Recipe): SpinePlan2 {
  const recipe = pinned ?? menu.fallback
  const slots = menu.slots.slice(0, MAX_SEGMENTS)
  const hero = menu.heroCandidates.find((c) => slots.some((s) => s.id === c)) ?? slots[0]?.id ?? ''
  const roles = rolesFor(recipe, slots.length)
  const moves = movesOf(recipe).filter((m) => m !== 'hold')

  const shots: Shot2[] = slots.map((slot, i) => {
    const isHero = slot.id === hero
    const last = i === slots.length - 1
    const headline = i === 0 ? brief.product : last && brief.cta ? brief.cta : ''
    return {
      slot: slot.id,
      role: isHero && recipe.roles.includes('product') ? 'product' : roles[i],
      weight: isHero ? 'hold' : 'normal',
      move: moves.length > 0 ? moves[i % moves.length] : 'hold',
      speed: slot.kind === 'video' && isHero && recipe.speed.heroSlow ? 'slow' : 'normal',
      headline,
      punch_word: '',
      why: isHero ? 'the hero' : i === 0 ? 'the hook' : 'in order'
    }
  })

  return {
    reasoning: `Standard cut: ${recipe.name}, ${shots.length} shots, ${hero} as the hero.`,
    recipe: recipe.id,
    hero,
    style: recipe.type.styles[0],
    animation: recipe.type.animations[0],
    shots
  }
}
