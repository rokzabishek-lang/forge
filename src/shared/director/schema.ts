import type { ObjectSchema, StringSchema } from './conforms'
import type { Menu } from './menu'

/**
 * The shape of a plan.
 *
 * The model fills this in; the app checks it whole and applies it in one
 * transaction (docs/LLM.md). Every rule about how it is shaped comes from
 * docs/DIRECTOR.md §10.2 and is written down where the rule bites:
 *
 *  - `reasoning` is the FIRST property, so the model has room to think before
 *    it commits to a verdict — a schema whose first token is the answer forces
 *    the answer with no thought behind it.
 *  - Every label is an enum. A grammar-enforced enum is the highest-value
 *    constraint a small model can be given.
 *  - Flat. No `oneOf`, no `$ref`, every field required, every object closed —
 *    conforms.ts refuses anything else, and a test holds this file inside it.
 *  - Ids, never numbers. A segment ends at `cut_07`, not at 4.3 seconds; the
 *    cut was located by the beat analysis and the model cannot get it wrong.
 *
 * And one thing the review added: the ids are PER-REQUEST ENUMS. The menu is
 * known before the model is asked, so `slot`, `ends_at` and `enter` list
 * exactly the ids on offer. An invented `cut_25`, an unpadded `slot_1`, a
 * family that is not installed — all impossible at the decoder rather than
 * caught afterwards. The validator keeps its rows regardless, for the paths
 * that do not go through a grammar.
 */

/** Stamped on every decision, so a change to this shape is visible in old projects. */
export const SPINE_PASS = 'spine@1'

export const ROLES = ['hook', 'problem', 'product', 'proof', 'offer', 'cta'] as const
export type Role = (typeof ROLES)[number]

export const PACES = ['punchy', 'steady', 'calm'] as const
export type Pace = (typeof PACES)[number]

export const TONES = ['energetic', 'calm', 'premium', 'playful', 'urgent'] as const
export type Tone = (typeof TONES)[number]

/** ≈ 60 tokens: room to think, not to write an essay. */
export const MAX_REASONING_CHARS = 300
/** A headline is six words at most; forty characters is the hard ceiling at any duration. */
export const MAX_HEADLINE_CHARS = 40
/** What the panel shows of a `why` — it is clipped to this on the way in. */
export const MAX_WHY_CHARS = 60
/**
 * What the DECODER allows a `why` to be.
 *
 * Deliberately longer than what is kept. A grammar-enforced maxLength ends the
 * string mid-thought, and a small model that has just been cut off can lose
 * the thread: on Gemma 4 E2B a `why` stopped at 60 was followed twice by the
 * model closing the whole plan after one segment (docs/EVAL.md, run 2). The
 * median `why` is ~35 characters; 100 rarely binds, and the validator still
 * clips to 60.
 */
export const MAX_WHY_DECODE_CHARS = 100
export const MAX_SEGMENTS = 12

export interface Segment {
  /** A slot id from the menu. */
  slot: string
  role: Role
  /** A cut id from the menu; the segment starts where the previous one ended. */
  ends_at: string
  /** How this segment arrives: `cut`, or a transition family from the menu. */
  enter: string
  /** On-screen line, or empty for none. */
  headline: string
  /** The word in the headline that hits, copied verbatim; empty for none. */
  punch_word: string
  /** The model's reason, kept on the clip so the timeline reads back. */
  why: string
}

export interface SpinePlan {
  reasoning: string
  pace: Pace
  segments: Segment[]
}

export interface Brief {
  product: string
  benefit: string
  audience: string
  tone: Tone
  cta: string
  /** Target length in seconds. */
  seconds: number
  /** Copy language, e.g. "English", "Telugu". */
  language: string
}

const text = (maxLength: number, description: string): StringSchema => ({
  type: 'string',
  maxLength,
  description
})

/**
 * The plan schema for one request.
 *
 * `constrained` (the default) puts the menu's ids in as enums — this is what
 * goes to the model. `constrained: false` leaves them as strings and drops
 * the length limits; that is the shape the validator checks against, so a
 * plan with one unknown id or one long headline is REPAIRED by the semantic
 * rows rather than rejected whole for its shape.
 *
 * Property order is part of the contract: `reasoning` first, and each
 * object's `required` lists its properties in the order they are declared. A
 * test pins both.
 */
export function spineSchema(
  menu: Pick<Menu, 'slots' | 'cuts' | 'families'>,
  options: { constrained?: boolean } = {}
): ObjectSchema {
  const constrained = options.constrained ?? true
  if (constrained) {
    if (menu.slots.length === 0) throw new Error('Directing needs at least one picture or clip')
    if (menu.cuts.length < 2) throw new Error('Directing needs somewhere to cut')
  }

  const ids = (values: string[]): Pick<StringSchema, 'enum'> => (constrained ? { enum: values } : {})
  const limit = (n: number): Pick<StringSchema, 'maxLength'> => (constrained ? { maxLength: n } : {})

  const segment: ObjectSchema = {
    type: 'object',
    properties: {
      slot: {
        type: 'string',
        ...ids(menu.slots.map((s) => s.id)),
        description: 'A slot id from the menu, in menu order'
      },
      role: { type: 'string', enum: [...ROLES], description: 'What this segment does in the ad' },
      ends_at: {
        type: 'string',
        ...ids(menu.cuts.filter((c) => c.reason !== 'start').map((c) => c.id)),
        description: 'The cut id this segment ends on'
      },
      enter: {
        type: 'string',
        ...ids(menu.families.map((f) => f.id)),
        description: 'How this segment arrives: cut, or a transition family'
      },
      headline: { type: 'string', ...limit(MAX_HEADLINE_CHARS), description: 'On-screen line, six words at most, or empty' },
      punch_word: { type: 'string', ...limit(MAX_HEADLINE_CHARS), description: 'One word of the headline that hits, copied exactly, or empty' },
      why: { type: 'string', ...limit(MAX_WHY_DECODE_CHARS), description: 'Why this picture, here, in a few words' }
    },
    required: ['slot', 'role', 'ends_at', 'enter', 'headline', 'punch_word', 'why'],
    additionalProperties: false
  }

  return {
    type: 'object',
    properties: {
      reasoning: constrained
        ? text(MAX_REASONING_CHARS, 'Think here first, briefly: what the ad is and how it moves')
        : { type: 'string', description: 'Think here first, briefly: what the ad is and how it moves' },
      pace: { type: 'string', enum: [...PACES], description: 'Overall energy of the cut' },
      segments: {
        type: 'array',
        items: segment,
        minItems: 1,
        maxItems: MAX_SEGMENTS,
        description: 'The shots, in order, each ending on a cut'
      }
    },
    required: ['reasoning', 'pace', 'segments'],
    additionalProperties: false
  }
}
