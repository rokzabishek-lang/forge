import { describe, it, expect } from 'vitest'
import {
  segmentIntoSentences,
  wordsInRange,
  wordAt,
  nearestBoundaryMs,
  segmentById,
  transcriptText,
  PAUSE_BOUNDARY_MS,
  type Transcript,
  type Word
} from '@shared/transcript'

function words(spec: [string, number, number][]): Word[] {
  return spec.map(([text, startMs, endMs], index) => ({
    index,
    text,
    startMs,
    endMs,
    confidence: 0.9
  }))
}

/** The real faster-whisper output for the JFK fixture. */
const JFK = words([
  ['And', 0, 740], ['so', 740, 1080], ['my', 1080, 1340], ['fellow', 1340, 1680],
  ['Americans,', 1680, 2300], ['ask', 3400, 3840], ['not', 3840, 4580],
  ['what', 4580, 5700], ['your', 5700, 5900], ['country', 5900, 6400],
  ['can', 6400, 6600], ['do', 6600, 6800], ['for', 6800, 7000], ['you,', 7000, 7600],
  ['ask', 8000, 8300], ['what', 8300, 8500], ['you', 8500, 8700],
  ['can', 8700, 8900], ['do', 8900, 9100], ['for', 9100, 9300],
  ['your', 9300, 9500], ['country.', 9500, 10400]
])

describe('segmentIntoSentences', () => {
  it('splits on sentence-ending punctuation', () => {
    const segments = segmentIntoSentences(
      words([['Hello', 0, 400], ['there.', 400, 800], ['Next', 900, 1200], ['one.', 1200, 1500]])
    )
    expect(segments).toHaveLength(2)
    expect(segments[0].text).toBe('Hello there.')
    expect(segments[1].text).toBe('Next one.')
  })

  it('splits on a long pause even without punctuation', () => {
    const segments = segmentIntoSentences(
      words([['one', 0, 200], ['two', 200, 400], ['three', 400 + PAUSE_BOUNDARY_MS, 1400]])
    )
    expect(segments).toHaveLength(2)
    expect(segments[0].text).toBe('one two')
  })

  it('does not split on abbreviations', () => {
    const segments = segmentIntoSentences(
      words([['Dr.', 0, 300], ['Smith', 300, 700], ['arrived.', 700, 1100]])
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Dr. Smith arrived.')
  })

  it('does not split on a single-letter initial', () => {
    const segments = segmentIntoSentences(
      words([['J.', 0, 300], ['F.', 300, 600], ['Kennedy', 600, 1100]])
    )
    expect(segments).toHaveLength(1)
  })

  it('assigns stable sequential ids the director can reference', () => {
    const segments = segmentIntoSentences(JFK)
    expect(segments.map((s) => s.id)).toEqual(
      segments.map((_, i) => `s${i + 1}`)
    )
  })

  it('splits the real JFK transcript at the 1.1s pause', () => {
    const segments = segmentIntoSentences(JFK)
    // "Americans," ends at 2300, "ask" starts at 3400 — a 1100ms gap.
    expect(segments[0].text).toBe('And so my fellow Americans,')
    expect(segments[0].endMs).toBe(2300)
    expect(segments[1].startMs).toBe(3400)
  })

  it('covers every word exactly once, with no gaps or overlaps', () => {
    const segments = segmentIntoSentences(JFK)
    const covered: number[] = []
    for (const s of segments) {
      for (let i = s.wordStart; i <= s.wordEnd; i++) covered.push(i)
    }
    expect(covered).toEqual(JFK.map((w) => w.index))
  })

  it('returns nothing for an empty transcript', () => {
    expect(segmentIntoSentences([])).toEqual([])
  })
})

describe('transcript queries', () => {
  const transcript: Transcript = {
    assetId: 'a1',
    language: 'en',
    model: 'faster-whisper/tiny/int8',
    durationMs: 11000,
    words: JFK,
    segments: segmentIntoSentences(JFK)
  }

  it('finds the word being spoken at a moment', () => {
    expect(wordAt(transcript, 1500)?.text).toBe('fellow')
    // Inside the pause, no word is being spoken.
    expect(wordAt(transcript, 2800)).toBeNull()
  })

  it('returns words overlapping a range', () => {
    const found = wordsInRange(transcript, 1000, 1400)
    expect(found.map((w) => w.text)).toEqual(['so', 'my', 'fellow'])
  })

  it('snaps an approximate time to the nearest segment boundary', () => {
    // 2400 is just past the end of segment 1 (2300).
    expect(nearestBoundaryMs(transcript, 2400)).toBe(2300)
    // 3350 is just before the start of segment 2 (3400).
    expect(nearestBoundaryMs(transcript, 3350)).toBe(3400)
  })

  it('looks a segment up by id', () => {
    expect(segmentById(transcript, 's1')?.startMs).toBe(0)
    expect(segmentById(transcript, 'nope')).toBeNull()
  })

  it('reassembles the full text', () => {
    expect(transcriptText(transcript)).toContain('ask not what your country')
  })
})
