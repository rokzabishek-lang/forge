import type { Word } from '../transcript'
import { secondsToFrames } from '../timeline'
import type { MusicAnalysis } from './cutPlan'

/**
 * Cutting to the LYRIC rather than to the beat under it.
 *
 * A singer never sits exactly on the grid. They push ahead of the beat or lay
 * back behind it, and that displacement is not sloppiness — it is the
 * performance. So an edit placed on the beat during a vocal line reads as
 * mechanical, and the same edit placed on the syllable reads as though the
 * cutter was listening. This module is where the second kind comes from.
 *
 * The hierarchy it assumes, loosest to tightest:
 *
 *   beat        the metre. Already ours, from librosa.
 *   word        the sung word. Whisper gives these, once it is pointed at a
 *               voice track rather than at a full mix.
 *   syllable    inside a word. Approximated here from the word's own text and
 *               its span, which is enough at editing resolution.
 *   phoneme     inside a syllable. NOT here, and deliberately: at 30fps one
 *               frame is 33ms and phonemes sit 50-80ms apart, so the whole
 *               range of the thing is one or two frames. It matters for
 *               lip-sync and it does not pay for itself in a music edit.
 *
 * And the punch is not evenly spread across those. A plosive — p, b, t, d, k,
 * g — starts with the vocal tract sealed and then released, so it has a genuine
 * transient in it, the same shape as a drum hit. A vowel starts gradually and
 * has no edge to cut on at all. That difference is worth more than any amount
 * of extra timing precision, and it costs a lookup table.
 */

/** How hard a word lands, 0..1. */
export type Punch = number

/**
 * Consonants that begin with a closure and release it. These are the words
 * worth putting a hard cut on; everything else is a soft landing.
 */
const PLOSIVES = new Set(['p', 'b', 't', 'd', 'k', 'g'])
/** Air forced through a narrow gap: an edge, but a soft one. */
const FRICATIVES = new Set(['f', 'v', 's', 'z', 'h', 'j'])
/** Two letters that are one sound, and which of them bite. */
const DIGRAPHS: Record<string, number> = {
  ch: 0.95,
  tr: 0.95,
  dr: 0.9,
  st: 0.8,
  sp: 0.8,
  sk: 0.8,
  br: 0.85,
  cr: 0.9,
  gr: 0.85,
  pr: 0.9,
  bl: 0.8,
  cl: 0.85,
  gl: 0.8,
  th: 0.45,
  sh: 0.5,
  wh: 0.35,
  ph: 0.6,
  kn: 0.5,
  wr: 0.3
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])

/**
 * How hard a word's opening lands.
 *
 * Read off the spelling rather than off the audio, which sounds like a
 * compromise and mostly is not: the first sound of a written word and the first
 * sound of the sung one are the same sound, and the alternative is a forced
 * aligner and a second model for information that is already in the transcript.
 */
export function punchOf(text: string): Punch {
  const word = text.toLowerCase().replace(/[^a-z']/g, '')
  if (!word) return 0.2

  const pair = word.slice(0, 2)
  if (pair in DIGRAPHS) return DIGRAPHS[pair]

  const first = word[0]
  if (PLOSIVES.has(first)) return 1
  if (FRICATIVES.has(first)) return 0.55
  if (first === 'c') return word[1] === 'e' || word[1] === 'i' ? 0.55 : 0.9
  if (first === 'q' || first === 'x') return 0.85
  if (first === 'm' || first === 'n' || first === 'l' || first === 'r') return 0.4
  if (first === 'w' || first === 'y') return 0.3
  // A word that opens on a vowel has no edge to cut on.
  if (VOWELS.has(first)) return 0.2
  return 0.4
}

/**
 * Syllable count, from the spelling.
 *
 * The usual vowel-group heuristic with the usual corrections: a trailing silent
 * `e`, and the fact that every word has at least one. It is wrong often enough
 * that it would be no good for a dictionary and right often enough to divide a
 * word's span into beats you can cut on.
 */
export function syllableCount(text: string): number {
  const word = text.toLowerCase().replace(/[^a-z]/g, '')
  if (word.length <= 3) return word.length > 0 ? 1 : 0

  const groups = word
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    // A RUN of vowels is one nucleus however long it is: capping it at two
    // split "beautiful" into four, because "eau" came apart as "ea" plus "u".
    .match(/[aeiouy]+/g)
  return Math.max(1, groups ? groups.length : 1)
}

export interface Accent {
  /** Milliseconds into the analysed window. */
  ms: number
  punch: Punch
  /** The word this came from, for the reason line. */
  text: string
  /** True when it is the start of the word rather than a later syllable. */
  onset: boolean
}

/**
 * Every place in a vocal worth landing something on.
 *
 * Syllables after the first are given a share of the word's punch rather than
 * its full value: the stress is on the attack, and a cut on the second syllable
 * of a word is a weaker moment than a cut on the first by any measure.
 */
export function accentsFrom(words: Word[], options: { syllables?: boolean } = {}): Accent[] {
  const out: Accent[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const punch = punchOf(text)
    out.push({ ms: word.startMs, punch, text, onset: true })

    if (!options.syllables) continue
    const count = syllableCount(text)
    const span = word.endMs - word.startMs
    // Only worth subdividing a word that is actually held: splitting a 90ms
    // word into three gives three moments no one can tell apart.
    if (count < 2 || span < 180) continue
    for (let i = 1; i < count; i++) {
      out.push({
        ms: Math.round(word.startMs + (span * i) / count),
        punch: punch * 0.45,
        text,
        onset: false
      })
    }
  }
  return out.sort((a, b) => a.ms - b.ms)
}

export interface LyricCutOptions {
  fps: number
  /** Only accents at least this hard become cuts. */
  minPunch?: number
  /** Nothing closer together than this. Two cuts a few frames apart is a glitch. */
  minGapMs?: number
  /** Split long words into syllables as well as taking their openings. */
  syllables?: boolean
  /**
   * How far an accent may be pulled onto the musical grid.
   *
   * THE important number, and the whole argument of this module is about it. A
   * vocal that sits 30ms off the beat is a performance and must be left alone;
   * one that sits 8ms off is the same moment as the beat and may as well be
   * quantised, because a frame is 33ms and nobody can see the difference. Set
   * it too high and every accent gets dragged onto the grid, which is exactly
   * the mechanical feel this exists to avoid.
   */
  snapMs?: number
  analysis?: MusicAnalysis | null
}

export interface LyricCut {
  ms: number
  frame: number
  punch: Punch
  text: string
  /** True when it was pulled onto a beat, so the reason can say so. */
  snapped: boolean
  reason: string
}

export const DEFAULT_MIN_PUNCH = 0.55
export const DEFAULT_MIN_GAP_MS = 160
/**
 * Half a frame at 30fps.
 *
 * Deliberately small. The grid is where the metre is, and the voice is where
 * the expression is; pulling the second onto the first is throwing away the
 * thing that made it worth cutting to. This only absorbs accents that were
 * already on the beat to within less than a frame.
 */
export const DEFAULT_SNAP_MS = 16

/**
 * Where to cut, given a vocal and optionally the music under it.
 *
 * The music is not required. With it, accents that were already within a
 * whisker of a beat are tidied onto it — which keeps a chorus that was sung
 * dead on the grid looking dead on the grid — and every other accent is left
 * exactly where the singer put it.
 */
export function planLyricCuts(words: Word[], options: LyricCutOptions): LyricCut[] {
  const {
    fps,
    minPunch = DEFAULT_MIN_PUNCH,
    minGapMs = DEFAULT_MIN_GAP_MS,
    snapMs = DEFAULT_SNAP_MS,
    syllables = false,
    analysis = null
  } = options

  const beats = analysis?.beats ?? []
  const nearestBeat = (ms: number): number | null => {
    if (beats.length === 0) return null
    let best = beats[0]
    for (const beat of beats) {
      if (Math.abs(beat - ms) < Math.abs(best - ms)) best = beat
    }
    return best
  }

  const cuts: LyricCut[] = []
  for (const accent of accentsFrom(words, { syllables })) {
    if (accent.punch < minPunch) continue

    const beat = nearestBeat(accent.ms)
    const snapped = beat !== null && Math.abs(beat - accent.ms) <= snapMs
    const ms = snapped ? beat! : accent.ms

    // Keep the harder of two accents that land on top of each other, rather
    // than the earlier one: the point of this is to find the punchy moments.
    const clash = cuts[cuts.length - 1]
    if (clash && ms - clash.ms < minGapMs) {
      if (accent.punch > clash.punch) cuts.pop()
      else continue
    }

    cuts.push({
      ms,
      frame: secondsToFrames(ms / 1000, fps),
      punch: accent.punch,
      text: accent.text,
      snapped,
      reason: accent.onset
        ? `on “${accent.text}”${snapped ? ', on the beat' : ''}`
        : `inside “${accent.text}”`
    })
  }
  return cuts
}

/**
 * How much of the vocal was left where it was sung.
 *
 * Diagnostic rather than decorative: if this comes back near zero the snap
 * window is too wide and the edit has been quantised into the thing it was
 * supposed to be an alternative to.
 */
export function offGridShare(cuts: LyricCut[]): number {
  if (cuts.length === 0) return 0
  return cuts.filter((c) => !c.snapped).length / cuts.length
}
