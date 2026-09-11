/**
 * Transcripts and word-level timing.
 *
 * Times are milliseconds into the SOURCE media, never timeline frames. A
 * transcript belongs to an asset, not to a project — storing frames would
 * silently corrupt every transcript the moment the project frame rate changed.
 * Conversion to frames happens where a transcript meets the timeline.
 */

export interface Word {
  /** Position in the transcript. Stable, and what emphasis ops reference. */
  index: number
  text: string
  startMs: number
  endMs: number
  confidence: number | null
}

/**
 * A sentence-ish span. These are the boundary IDs the director picks from: a
 * cut can never land mid-word because mid-word is not on the menu.
 * See docs/DIRECTOR.md §1.
 */
export interface Segment {
  /** Stable opaque id, e.g. "s47". */
  id: string
  startMs: number
  endMs: number
  text: string
  /** Inclusive range of word indices. */
  wordStart: number
  wordEnd: number
}

export interface Transcript {
  assetId: string
  language: string
  /** Model id and runtime, recorded so a later upgrade is visible. */
  model: string
  durationMs: number
  words: Word[]
  segments: Segment[]
}

/** A pause at least this long ends a segment even without punctuation. */
export const PAUSE_BOUNDARY_MS = 700

const SENTENCE_END = /[.!?…]["')\]]*$/
/** Abbreviations whose trailing dot is not a sentence end. */
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.',
  'vs.', 'etc.', 'e.g.', 'i.e.', 'inc.', 'ltd.', 'co.', 'approx.'
])

function endsSentence(text: string): boolean {
  const lower = text.toLowerCase()
  if (ABBREVIATIONS.has(lower)) return false
  // A single capital followed by a dot is an initial ("J." in "J. Smith").
  if (/^[A-Z]\.$/.test(text)) return false
  return SENTENCE_END.test(text)
}

/**
 * Group words into sentence-like segments.
 *
 * Splits on sentence punctuation, and on long pauses — speech often runs on
 * without punctuation, and a pause is a better cut point than an arbitrary word
 * count. Both rules operate on whole words, so a boundary can never fall inside
 * one.
 */
export function segmentIntoSentences(
  words: Word[],
  pauseMs: number = PAUSE_BOUNDARY_MS
): Segment[] {
  const segments: Segment[] = []
  if (words.length === 0) return segments

  let start = 0

  const flush = (end: number): void => {
    const slice = words.slice(start, end + 1)
    if (slice.length === 0) return
    segments.push({
      id: `s${segments.length + 1}`,
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      text: slice.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
      wordStart: slice[0].index,
      wordEnd: slice[slice.length - 1].index
    })
    start = end + 1
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const next = words[i + 1]

    if (endsSentence(word.text)) {
      flush(i)
      continue
    }
    if (next && next.startMs - word.endMs >= pauseMs) {
      flush(i)
    }
  }

  if (start < words.length) flush(words.length - 1)
  return segments
}

/* ------------------------------------------------------------- queries */

export function wordsInRange(transcript: Transcript, startMs: number, endMs: number): Word[] {
  return transcript.words.filter((w) => w.endMs > startMs && w.startMs < endMs)
}

export function segmentById(transcript: Transcript, id: string): Segment | null {
  return transcript.segments.find((s) => s.id === id) ?? null
}

/** The word being spoken at a moment, for caption highlighting. */
export function wordAt(transcript: Transcript, ms: number): Word | null {
  return transcript.words.find((w) => ms >= w.startMs && ms < w.endMs) ?? null
}

export function transcriptText(transcript: Transcript): string {
  return transcript.segments.map((s) => s.text).join(' ')
}

/**
 * Nearest segment boundary to a time — the snap that turns an approximate
 * intent into a frame-accurate cut.
 */
export function nearestBoundaryMs(transcript: Transcript, ms: number): number {
  let best = ms
  let bestDistance = Infinity
  for (const segment of transcript.segments) {
    for (const candidate of [segment.startMs, segment.endMs]) {
      const distance = Math.abs(candidate - ms)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
  }
  return best
}
