import type { ObjectSchema, StringSchema } from './conforms'
import type { Slot } from './menu'
import { MAX_HEADLINE_CHARS, MAX_REASONING_CHARS, MAX_SEGMENTS } from './schema'
import { ROLES2, type Recipe, type RecipeId, type Role2 } from './recipes'

/**
 * `spine@2` — the plan once the recipe times the ad (docs/PLAN.md §5.2).
 *
 * `spine@1` asked the model to end each segment on a cut; over twelve
 * segments that IS shaping a pacing curve, which a small model cannot do, and
 * C0 measured it failing exactly there (every rejection was the model running
 * out of cuts, docs/EVAL.md). So `ends_at` is gone. The model chooses the
 * recipe, the hero among the gate's candidates, one text style and animation
 * for the ad, and per shot a WEIGHT (quick / normal / hold — never a time), a
 * camera move and a speed; the rhythm engine times all of it.
 *
 * One flat decode, built before the model answers, so the move, style and
 * animation enums are the UNION of the offered recipes' lists; the validator
 * repairs a choice outside the chosen recipe's own list (validate2.ts).
 */

export const SPINE2_PASS = 'spine@2'

export const WEIGHTS = ['quick', 'normal', 'hold'] as const
export type Weight = (typeof WEIGHTS)[number]

export const SPEEDS = ['normal', 'slow', 'ramp'] as const
export type Speed = (typeof SPEEDS)[number]

/**
 * What the decoder allows a `why` to be — longer than the 60 the panel keeps.
 * A `why` cut off by the grammar mid-thought was twice followed by the model
 * closing the whole plan after one segment (docs/EVAL.md, run 2).
 */
export const MAX_WHY2_DECODE_CHARS = 100

export interface Shot2 {
  slot: string
  role: Role2
  weight: Weight
  /** A move from the recipe's list, or `hold` for none. */
  move: string
  /** For a clip: normal, slow (the hero clip), or a ramp. Stills are always normal. */
  speed: Speed
  headline: string
  punch_word: string
  why: string
}

export interface SpinePlan2 {
  reasoning: string
  recipe: RecipeId
  /** A slot id from the gate's hero candidates. */
  hero: string
  /** One text style and one animation for every card in the ad. */
  style: string
  animation: string
  shots: Shot2[]
}

/** What the model is offered for one ad. */
export interface Menu2 {
  /** The gated slots, in the user's order, with what the eyes saw. */
  slots: Slot[]
  /** The recipes on offer — all of them, or the one the user pinned. */
  recipes: Recipe[]
  /** The recipe when the model's choice cannot be used — the tone's (recipes/index.ts). */
  fallback: Recipe
  /** Slot ids that may be the hero, best first (gate.ts). Never empty when there are slots. */
  heroCandidates: string[]
  fps: number
  /** The ad's length and what the music holds. */
  seconds: number
  bpm: number
  /** How many shots the music comfortably holds, low to high. */
  holds: { min: number; max: number }
  /** Drops in the music, in seconds from the ad's start — for the model's sense of it, not for timing. */
  drops: number[]
}

const union = (lists: string[][]): string[] => [...new Set(lists.flat())]

export function movesOf(recipe: Recipe): string[] {
  return union([recipe.moves.stills, ['hold']])
}

/**
 * The plan schema for one request. `constrained` (the default) puts the
 * request's ids in as enums; `constrained: false` is what the validator checks
 * the shape against, so a choice outside a list is repaired, not rejected.
 * `reasoning` first; every object's `required` in declaration order.
 */
export function spine2Schema(menu: Pick<Menu2, 'slots' | 'recipes' | 'heroCandidates'>, options: { constrained?: boolean } = {}): ObjectSchema {
  const constrained = options.constrained ?? true
  if (constrained) {
    if (menu.slots.length === 0) throw new Error('Directing needs at least one picture or clip')
    if (menu.recipes.length === 0) throw new Error('Directing needs at least one recipe')
  }
  const ids = (values: string[]): Pick<StringSchema, 'enum'> => (constrained ? { enum: values } : {})
  const limit = (n: number): Pick<StringSchema, 'maxLength'> => (constrained ? { maxLength: n } : {})
  const heroes = menu.heroCandidates.length > 0 ? menu.heroCandidates : menu.slots.map((s) => s.id)

  const shot: ObjectSchema = {
    type: 'object',
    properties: {
      slot: { type: 'string', ...ids(menu.slots.map((s) => s.id)), description: 'A slot id, in slot order' },
      role: { type: 'string', ...ids([...ROLES2]), description: "What this shot does, from the recipe's roles" },
      weight: { type: 'string', ...ids([...WEIGHTS]), description: 'How much this shot matters: quick, normal, or hold' },
      move: { type: 'string', ...ids(union(menu.recipes.map(movesOf))), description: "The camera move, from the recipe's moves; hold is still" },
      speed: { type: 'string', ...ids([...SPEEDS]), description: 'For a clip: normal, slow, or ramp; a still is normal' },
      headline: { type: 'string', ...limit(MAX_HEADLINE_CHARS), description: 'On-screen line, six words at most, or empty' },
      punch_word: { type: 'string', ...limit(MAX_HEADLINE_CHARS), description: 'One word of the headline that hits, copied exactly, or empty' },
      why: { type: 'string', ...limit(MAX_WHY2_DECODE_CHARS), description: 'Why this picture, here, in a few words' }
    },
    required: ['slot', 'role', 'weight', 'move', 'speed', 'headline', 'punch_word', 'why'],
    additionalProperties: false
  }

  return {
    type: 'object',
    properties: {
      reasoning: { type: 'string', ...limit(MAX_REASONING_CHARS), description: 'Think here first, briefly: what the ad is and which recipe fits' },
      recipe: { type: 'string', ...ids(menu.recipes.map((r) => r.id)), description: 'The recipe that fits the brief and the pictures' },
      hero: { type: 'string', ...ids(heroes), description: 'The one picture the ad is built around, from HERO' },
      style: { type: 'string', ...ids(union(menu.recipes.map((r) => r.type.styles))), description: "The ad's text style, from the recipe's styles" },
      animation: { type: 'string', ...ids(union(menu.recipes.map((r) => r.type.animations))), description: "The ad's text animation, from the recipe's" },
      shots: { type: 'array', items: shot, minItems: 1, maxItems: MAX_SEGMENTS, description: 'The shots, in slot order' }
    },
    required: ['reasoning', 'recipe', 'hero', 'style', 'animation', 'shots'],
    additionalProperties: false
  }
}
