import type { ObjectSchema } from './conforms'
import type { Brief } from './schema'

/**
 * The look pass — the VLM as the Director's eyes (docs/PLAN.md §4.1).
 *
 * An ad uses few photos, so each one can simply be shown to the model: one
 * image a call, answered from closed lists plus twelve words of what is there,
 * so the spine's copy is about the picture rather than about its file name.
 * Cached in the project by the file's size and mtime, so a retry never looks
 * twice.
 *
 * `hero` is a coarse bucket and only ever a FILTER (gate.ts). A small model
 * cannot rate one photo on a scale that means the same for the next — it can
 * compare — so the comparison is made by the spine call, which sees every
 * photo's look at once (docs/DIRECTOR.md §10.5).
 */

export const LOOK_PASS = 'look@1'

export const PEOPLE = ['none', 'one', 'two', 'group'] as const
export const SHOTS = ['wide', 'medium', 'close', 'detail'] as const
export const MOODS = ['warm', 'calm', 'joyful', 'dramatic', 'clean', 'dark'] as const
export const PRODUCT_VISIBLE = ['yes', 'no', 'unsure'] as const
export const HERO_BUCKETS = ['weak', 'usable', 'strong'] as const

export type People = (typeof PEOPLE)[number]
export type ShotSize = (typeof SHOTS)[number]
export type Mood = (typeof MOODS)[number]
export type HeroBucket = (typeof HERO_BUCKETS)[number]

export interface Look {
  people: People
  shot: ShotSize
  mood: Mood
  product_visible: (typeof PRODUCT_VISIBLE)[number]
  hero: HeroBucket
  /** Up to twelve words of what is in the picture, in the brief's language. */
  words: string
}

/** A look as the project keeps it: which file it was of, and who looked. */
export interface StoredLook extends Look {
  /** The file's `size:mtime` when it was looked at — the cheap key stems.ts and maskTags.ts use. */
  key: string
  model: string
  at: string
}

export const MAX_LOOK_REASONING = 200
/** Room for one look: the reasoning, five enums and twelve words, with JSON punctuation. */
export const LOOK_MAX_TOKENS = 320
export const MAX_LOOK_WORDS = 12
/** Twelve words is about this many characters, with room for a long word or two. */
export const MAX_LOOK_CHARS = 90

export function lookSchema(): ObjectSchema {
  return {
    type: 'object',
    properties: {
      reasoning: { type: 'string', maxLength: MAX_LOOK_REASONING, description: 'Think here first, briefly: what the picture shows' },
      // Words before the lists: the description is written first, so the counts can agree with it.
      words: { type: 'string', maxLength: MAX_LOOK_CHARS, description: 'Up to twelve words: what is in the picture' },
      people: { type: 'string', enum: [...PEOPLE], description: 'How many people the picture is of' },
      shot: { type: 'string', enum: [...SHOTS], description: 'How close the camera is' },
      mood: { type: 'string', enum: [...MOODS], description: 'The feeling of the picture' },
      product_visible: { type: 'string', enum: [...PRODUCT_VISIBLE], description: 'Is the product itself in the picture' },
      hero: { type: 'string', enum: [...HERO_BUCKETS], description: 'Could this be the main shot of the ad' }
    },
    required: ['reasoning', 'words', 'people', 'shot', 'mood', 'product_visible', 'hero'],
    additionalProperties: false
  }
}

/** The same for every photo, so a server caches it once (DIRECTOR.md §10.6). */
export const LOOK_SYSTEM = `You look at one photograph for an ad and describe it. You answer with one JSON object and nothing else.

- people: how many people the picture is OF — none, one, two, or a group of three or more. Count the subjects, not a crowd blurred behind them. It must agree with your words: if your words say "two men", people is two.
- shot: wide (the whole scene), medium (a person from the waist up, or a product with its surroundings), close (a face, or the product filling the frame), detail (hands, a texture, a small part).
- mood: the feeling of the picture.
- product_visible: yes only if the product named in the brief can be seen.
- hero: strong if this could be the main shot of the ad; usable if it could be in the ad; weak if it is blurred, badly lit or empty.
- words: up to twelve words of what is actually in the picture — concrete nouns, no adjectives about quality, and nothing from the brief that you cannot see. In the language the user asks for.
- reasoning comes first: one sentence on what you see.`

export function lookPrompt(brief: Pick<Brief, 'product' | 'language'>): { system: string; user: string } {
  return {
    system: LOOK_SYSTEM,
    // The product is named ONLY for product_visible: named as "the ad is for", a small model wrote it into
    // the words of a test pattern ("… wedding film") — describing the brief instead of the picture.
    user: `Describe this picture. Write "words" in ${brief.language.trim() || 'English'}, about what you see only.\nFor product_visible alone: the product is "${brief.product}".`
  }
}

/** The answer, checked; null when it is not a look (the photo then simply has none). */
export function readLook(value: unknown): Look | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const one = <T extends string>(list: readonly T[], x: unknown): x is T => typeof x === 'string' && (list as readonly string[]).includes(x)
  if (!one(PEOPLE, v.people) || !one(SHOTS, v.shot) || !one(MOODS, v.mood)) return null
  if (!one(PRODUCT_VISIBLE, v.product_visible) || !one(HERO_BUCKETS, v.hero)) return null
  const words = typeof v.words === 'string' ? v.words.trim().split(/\s+/).filter(Boolean).slice(0, MAX_LOOK_WORDS).join(' ') : ''
  return { people: v.people, shot: v.shot, mood: v.mood, product_visible: v.product_visible, hero: v.hero, words }
}

/** How a look reads in the spine's SLOTS table: `two, close, joyful, strong: "bride laughing, veil"`. */
export function lookLine(look: Look): string {
  return `${look.people}, ${look.shot}, ${look.mood}, ${look.hero}${look.words ? `: "${look.words}"` : ''}`
}
