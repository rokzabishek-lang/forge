import type { Transcript, Word } from '../transcript'

/**
 * Keyword triggering for props and stickers.
 *
 * Deliberately model-free: the transcript already carries word-level timing, so
 * a match gives a frame-accurate insertion point for nothing. The engineering
 * here is not the matching — it is avoiding false positives, which is what makes
 * the difference between "this feels intentional" and "this fires constantly".
 * See docs/AUTOMATION.md §2.
 */

export interface PropTrigger {
  /** Catalog entry id of the prop or sticker. */
  assetId: string
  /** Asset path relative to the assets root. */
  file: string
  name: string
  /** Words that fire it. Matched on whole tokens after light stemming. */
  tags: string[]
}

export interface TriggerOptions {
  /** Upper bound on how often anything fires, per minute of media. */
  perMinute: number
  /** Minimum gap before the SAME prop may fire again, in ms. */
  cooldownMs: number
  fps: number
}

export interface TriggerHit {
  assetId: string
  file: string
  name: string
  /** Index of the word that fired it. */
  wordIndex: number
  /** Word that matched, for showing the user why this fired. */
  matchedWord: string
  tag: string
  startMs: number
}

export const DEFAULT_TRIGGER_OPTIONS: Omit<TriggerOptions, 'fps'> = {
  // A rate is something a user can reason about; a probability is not.
  perMinute: 4,
  cooldownMs: 12_000
}

/** Lowercase and strip punctuation. No stemming — see wordMatchesTag. */
export function normaliseToken(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9']/g, '')
}

/**
 * Inflections generated FROM a tag, rather than stemming the incoming word.
 *
 * Stemming both sides over-reaches: "flames" stems to "flam" while "flame"
 * stays whole, so they never meet — and loosening the stemmer to fix that is
 * exactly what starts matching "fired" to fire. Expanding a known base form is
 * bounded and predictable.
 *
 * "-ed" is deliberately absent: "fired" means dismissed far more often than it
 * means aflame, and a prop that fires on it feels broken.
 */
export function inflectionsOf(tag: string): string[] {
  const base = normaliseToken(tag)
  if (base.length < 3) return [base]

  const forms = new Set([base, `${base}s`, `${base}es`, `${base}ing`])
  // "flame" -> "flaming": a silent e is dropped before -ing.
  if (base.endsWith('e')) forms.add(`${base.slice(0, -1)}ing`)
  // "run" -> "running": a final consonant doubles.
  if (/[^aeiou]$/.test(base)) forms.add(`${base}${base.slice(-1)}ing`)
  return [...forms]
}

/**
 * Whole-token match, never substring.
 *
 * "fired" must not trigger the fire prop and "brainstorm" must not trigger
 * brain — substring matching gets both wrong, and it is the single most common
 * way this feature becomes annoying.
 */
export function wordMatchesTag(word: string, tag: string): boolean {
  return inflectionsOf(tag).includes(normaliseToken(word))
}

function firstMatch(word: Word, triggers: PropTrigger[]): { trigger: PropTrigger; tag: string } | null {
  for (const trigger of triggers) {
    for (const tag of trigger.tags) {
      if (wordMatchesTag(word.text, tag)) return { trigger, tag }
    }
  }
  return null
}

/**
 * Find where props should fire across a transcript.
 *
 * Applies a per-prop cooldown and a global rate cap, because the same prop three
 * times in ten seconds reads as broken rather than emphatic.
 */
export function findTriggerHits(
  transcript: Transcript,
  triggers: PropTrigger[],
  options: TriggerOptions
): TriggerHit[] {
  if (triggers.length === 0 || transcript.words.length === 0) return []

  const hits: TriggerHit[] = []
  const lastFired = new Map<string, number>()

  const durationMinutes = Math.max(transcript.durationMs / 60_000, 1 / 60)
  const cap = Math.max(1, Math.floor(options.perMinute * durationMinutes))

  for (const word of transcript.words) {
    if (hits.length >= cap) break

    const match = firstMatch(word, triggers)
    if (!match) continue

    const previous = lastFired.get(match.trigger.assetId)
    if (previous !== undefined && word.startMs - previous < options.cooldownMs) continue

    lastFired.set(match.trigger.assetId, word.startMs)
    hits.push({
      assetId: match.trigger.assetId,
      file: match.trigger.file,
      name: match.trigger.name,
      wordIndex: word.index,
      matchedWord: word.text,
      tag: match.tag,
      startMs: word.startMs
    })
  }

  return hits
}

/**
 * Tags for the props in the library.
 *
 * Filenames alone catch a fraction of real hits — `fire_3d.png` should fire on
 * flame, burn, hot and lit as well as fire. Authored once, extended as the
 * library grows.
 */
export const PROP_TAGS: Record<string, string[]> = {
  fire: ['fire', 'flame', 'burn', 'hot', 'lit', 'heat', 'blaze'],
  brain: ['brain', 'think', 'idea', 'smart', 'mind', 'genius', 'learn'],
  rocket: ['rocket', 'launch', 'grow', 'scale', 'fast', 'boost', 'skyrocket'],
  target: ['target', 'goal', 'aim', 'focus', 'objective', 'hit'],
  coin: ['coin', 'money', 'cash', 'profit', 'revenue', 'price', 'pay', 'dollar'],
  'holographic badge': ['badge', 'award', 'win', 'achievement', 'verified', 'best']
}

/** Match a prop's display name to its tag list, falling back to the name itself. */
export function tagsForProp(name: string): string[] {
  const key = name.toLowerCase().trim()
  if (PROP_TAGS[key]) return PROP_TAGS[key]
  const partial = Object.keys(PROP_TAGS).find((k) => key.includes(k))
  return partial ? PROP_TAGS[partial] : [key]
}
