import { conforms, type Problem } from './conforms'
import { MAX_REASONING_CHARS, MAX_WHY_CHARS } from './schema'
import { punchIndex } from './validate'
import { recipeById, type Recipe, type Role2 } from './recipes'
import { SPEEDS, WEIGHTS, movesOf, spine2Schema, type Menu2, type Shot2, type SpinePlan2 } from './schema2'

/**
 * Does a `spine@2` plan make sense against its menu (docs/PLAN.md §5.2).
 *
 * With the timing gone from the plan, most of what `spine@1` had to REJECT
 * can be REPAIRED: a shot out of slot order is simply put back in order (no
 * span depends on its position any more), an unknown recipe falls to the
 * tone's, a hero that is not a candidate becomes the first candidate, and a
 * move, style or animation from another recipe's list — legal at the decoder,
 * because the enums are the union of every recipe offered — becomes the chosen
 * recipe's own. Fewer rejections by construction is the reliability win.
 *
 * Still rejected: an answer cut off at the token cap, the wrong shape, and a
 * plan with no usable shot. Headline length is checked after the rhythm engine
 * has timed the shots (compose.ts), because only then is it known how long
 * each card is on screen.
 */

export interface Validated2 {
  plan: SpinePlan2
  recipe: Recipe
  problems: Problem[]
}

export type Spine2Verdict = Validated2 | { rejected: string; problems: Problem[] }

const clip = (text: string, max: number): string =>
  Array.from(text).length <= max ? text : `${Array.from(text).slice(0, max - 1).join('')}…`

export function validateSpine2(raw: unknown, menu: Menu2, options: { truncated?: boolean } = {}): Spine2Verdict {
  const problems: Problem[] = []
  if (options.truncated) return { rejected: "The model's plan ran out of room before it finished", problems }

  const shape = conforms(spine2Schema(menu, { constrained: false }), raw)
  if (shape.length > 0) return { rejected: `The plan is not the shape asked for — ${shape[0].path} ${shape[0].message}`, problems: shape }
  const plan = raw as SpinePlan2

  /* The recipe: one on offer, or the tone's. */
  let recipe = menu.recipes.find((r) => r.id === plan.recipe) ?? null
  if (!recipe) {
    recipe = menu.fallback
    problems.push({ path: '$.recipe', message: `"${plan.recipe}" is not a recipe on offer — used ${recipe.name}` })
  }

  /* Shots: known slots, once each, put back in the user's order. */
  const order = new Map(menu.slots.map((s, i) => [s.id, i]))
  const seen = new Set<string>()
  const kept: { shot: Shot2; index: number; at: string }[] = []
  plan.shots.forEach((shot, i) => {
    const at = `$.shots[${i}]`
    const index = order.get(shot.slot)
    if (index === undefined) {
      problems.push({ path: `${at}.slot`, message: `"${shot.slot}" is not on the menu — shot dropped` })
      return
    }
    if (seen.has(shot.slot)) {
      problems.push({ path: `${at}.slot`, message: `"${shot.slot}" is used twice — the second dropped` })
      return
    }
    seen.add(shot.slot)
    kept.push({ shot, index, at })
  })
  if (kept.length === 0) return { rejected: "None of the plan's shots used a picture from the menu", problems }
  const sorted = kept.slice().sort((a, b) => a.index - b.index)
  if (sorted.some((k, i) => k !== kept[i])) {
    problems.push({ path: '$.shots', message: 'the shots were not in the order you placed them — put back in order' })
  }

  /* The hero: a candidate, and one of the shots. */
  let hero = plan.hero
  const used = new Set(sorted.map((k) => k.shot.slot))
  if (!menu.heroCandidates.includes(hero) || !used.has(hero)) {
    const replacement = menu.heroCandidates.find((c) => used.has(c))
    const why = !menu.heroCandidates.includes(hero) ? 'is not a hero candidate' : 'is not one of the shots'
    if (replacement) {
      problems.push({ path: '$.hero', message: `"${hero}" ${why} — ${replacement} is the hero` })
      hero = replacement
    } else {
      // No candidate among the shots: the first candidate joins them, in its place.
      const first = menu.heroCandidates[0] ?? sorted[0].shot.slot
      if (!used.has(first)) {
        const index = order.get(first) ?? 0
        const joined: Shot2 = { slot: first, role: 'product', weight: 'hold', move: 'hold', speed: 'normal', headline: '', punch_word: '', why: 'the hero' }
        sorted.push({ shot: joined, index, at: '$.hero' })
        sorted.sort((a, b) => a.index - b.index)
        problems.push({ path: '$.hero', message: `"${hero}" ${why} — ${first}, the best candidate, joins the shots as the hero` })
      } else {
        problems.push({ path: '$.hero', message: `"${hero}" ${why} — ${first} is the hero` })
      }
      hero = first
    }
  }

  /* One style and one animation, the chosen recipe's own. */
  let style = plan.style
  if (!recipe.type.styles.includes(style)) {
    problems.push({ path: '$.style', message: `"${style}" is not one of ${recipe.name}'s styles — used ${recipe.type.styles[0]}` })
    style = recipe.type.styles[0]
  }
  let animation = plan.animation
  if (!recipe.type.animations.includes(animation)) {
    problems.push({ path: '$.animation', message: `"${animation}" is not one of ${recipe.name}'s animations — used ${recipe.type.animations[0]}` })
    animation = recipe.type.animations[0]
  }

  /* Per shot: the recipe's roles and moves, speed only for clips, a punch word that is a word. */
  const moves = new Set(movesOf(recipe))
  const slotById = new Map(menu.slots.map((s) => [s.id, s]))
  const shots: Shot2[] = sorted.map(({ shot, at }) => {
    const out: Shot2 = { ...shot }
    const slot = slotById.get(out.slot)!
    if (!recipe!.roles.includes(out.role)) {
      const role: Role2 = recipe!.roles.includes('story') ? 'story' : recipe!.roles[Math.min(1, recipe!.roles.length - 1)]
      problems.push({ path: `${at}.role`, message: `"${out.role}" is not a role in ${recipe!.name} — ${role}` })
      out.role = role
    }
    if (!WEIGHTS.includes(out.weight)) out.weight = 'normal'
    if (!moves.has(out.move)) {
      problems.push({ path: `${at}.move`, message: `"${out.move}" is not one of ${recipe!.name}'s moves — held still` })
      out.move = 'hold'
    }
    if (!SPEEDS.includes(out.speed) || (slot.kind === 'image' && out.speed !== 'normal')) {
      if (slot.kind === 'image' && out.speed !== 'normal') problems.push({ path: `${at}.speed`, message: 'a still has no speed — normal' })
      out.speed = 'normal'
    }
    // A recipe without ramps (a wedding, fashion) does not get one because the decode allowed it.
    if (out.speed === 'ramp' && !recipe!.speed.ramp) {
      problems.push({ path: `${at}.speed`, message: `${recipe!.name} does not ramp — normal speed` })
      out.speed = 'normal'
    }
    // A ramp on a clip that speaks: atempo cannot follow a curve, and the words would smear.
    if (out.speed === 'ramp' && slot.speech) {
      problems.push({ path: `${at}.speed`, message: `${slot.id} has someone speaking — no ramp` })
      out.speed = 'normal'
    }
    out.headline = out.headline.trim()
    if (out.headline && out.punch_word.trim()) {
      if (punchIndex(out.headline, out.punch_word) === -1) {
        problems.push({ path: `${at}.punch_word`, message: `"${out.punch_word}" is not a word of "${out.headline}" — no word highlighted` })
        out.punch_word = ''
      }
    } else out.punch_word = ''
    out.why = clip(out.why.trim(), MAX_WHY_CHARS)
    return out
  })

  return {
    plan: { reasoning: clip(plan.reasoning.trim(), MAX_REASONING_CHARS), recipe: recipe.id, hero, style, animation, shots },
    recipe,
    problems
  }
}

export { recipeById }
