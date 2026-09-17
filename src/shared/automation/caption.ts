/**
 * Cut a caption into cards that land on bars.
 *
 * The governing constraint is reading speed, not word count. Subtitle practice
 * puts comfortable reading at roughly 15-17 characters a second, so how much
 * text fits on a card is decided by how long the card is on screen — which, in a
 * beat-synced edit, is decided by the tempo. At 120 BPM a bar is two seconds and
 * about thirty characters fit; at 160 BPM a bar is 1.5s and about twenty-four
 * do. The same caption therefore splits differently against different songs,
 * which is the point.
 *
 * Cards are measured in bars rather than beats deliberately. A title that
 * changes every beat flickers past unread at any tempo worth cutting to.
 */

/** Characters per second a viewer can comfortably read. */
export const READING_CPS = 16

/**
 * A card shorter than this reads as a flash, not as words — even when the
 * reading-rate maths says the text would fit.
 */
export const MIN_CARD_SECONDS = 1.2

/**
 * Hard ceiling on a single card regardless of how long it is held.
 *
 * A vertical reel is narrow. Past roughly this many characters the type has to
 * shrink to fit the width, and small type is unreadable on a phone whatever the
 * timing allows.
 */
export const MAX_CARD_CHARS = 48

export interface CaptionCard {
  text: string
  /** How many bars this card holds for. */
  bars: number
}

export interface SplitOptions {
  /** Seconds in one bar, from the tempo. */
  barSeconds: number
  readingCps?: number
  /** Longest a single card may hold. Beyond two bars a title goes stale. */
  maxBars?: number
  minCardSeconds?: number
}

/**
 * Split a caption into cards.
 *
 * Line breaks the user typed are honoured as card breaks — they meant them. Only
 * lines too long to read in a bar get broken further, at clause punctuation
 * first and word boundaries second, because splitting mid-clause is what makes
 * auto-captions read like a machine wrote them.
 */
export function splitCaption(caption: string, options: SplitOptions): CaptionCard[] {
  const {
    barSeconds,
    readingCps = READING_CPS,
    maxBars = 2,
    minCardSeconds = MIN_CARD_SECONDS
  } = options

  const capacity = (bars: number): number =>
    Math.min(
      MAX_CARD_CHARS,
      Math.max(1, Math.round(readingCps * Math.max(minCardSeconds, bars * barSeconds)))
    )
  const limit = capacity(1)

  const cards: CaptionCard[] = []
  for (const line of caption.split('\n').map((l) => l.trim())) {
    if (!line) continue
    for (const clause of splitClauses(line, limit)) {
      for (const chunk of packWords(clause, limit)) {
        cards.push({ text: chunk, bars: barsFor(chunk, barSeconds, readingCps, maxBars) })
      }
    }
  }
  return cards
}

/** How long a chunk needs, rounded up to whole bars. */
function barsFor(text: string, barSeconds: number, readingCps: number, maxBars: number): number {
  const needed = text.length / readingCps
  return Math.max(1, Math.min(maxBars, Math.ceil(needed / barSeconds)))
}

/**
 * Break at clause punctuation, keeping the punctuation with the clause before
 * it. Only runs when the line is genuinely too long — a short line with a comma
 * in it is one thought and should stay one card.
 */
function splitClauses(line: string, limit: number): string[] {
  if (line.length <= limit) return [line]
  const parts = line
    .split(/(?<=[,;:.!?—–])\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : [line]
}

/** Greedy word packing. A single word longer than the limit gets its own card. */
function packWords(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word
      continue
    }
    if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`
    } else {
      out.push(current)
      current = word
    }
  }
  if (current) out.push(current)
  return out
}

/** Seconds in a bar at a tempo, assuming common time. */
export function barSecondsFor(bpm: number, beatsPerBar = 4): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 2
  return (60 / bpm) * beatsPerBar
}
