import { describe, it, expect } from 'vitest'
import { buildAss, toAssColor, toAssTime, groupWords, REFERENCE_HEIGHT } from '@shared/captions/ass'
import { CAPTION_STYLES, styleById, resolveStyle, DEFAULT_CAPTION_STYLE } from '@shared/captions/style'
import { segmentIntoSentences, type Word } from '@shared/transcript'

function words(spec: [string, number, number][]): Word[] {
  return spec.map(([text, startMs, endMs], index) => ({ index, text, startMs, endMs, confidence: 0.9 }))
}

const SAMPLE = words([
  ['And', 0, 400], ['so', 400, 800], ['my', 800, 1200], ['fellow', 1200, 1600],
  ['Americans.', 1600, 2000], ['Ask', 2800, 3200], ['not.', 3200, 3600]
])
const SEGMENTS = segmentIntoSentences(SAMPLE)

const opts = { width: 1080, height: 1920, style: DEFAULT_CAPTION_STYLE }

describe('toAssColor', () => {
  it('byte-reverses hex into ASS BGR order', () => {
    // #FFD400 -> BB=00 GG=D4 RR=FF
    expect(toAssColor('#FFD400')).toBe('&H0000D4FF')
    expect(toAssColor('#FFFFFF')).toBe('&H00FFFFFF')
    expect(toAssColor('#000000')).toBe('&H00000000')
  })

  it('treats alpha as inverted, 00 being opaque', () => {
    expect(toAssColor('#000000', 0x80)).toBe('&H80000000')
  })

  it('tolerates a missing hash', () => {
    expect(toAssColor('FF0000')).toBe('&H000000FF')
  })
})

describe('toAssTime', () => {
  it('formats H:MM:SS.cc with centiseconds', () => {
    expect(toAssTime(0)).toBe('0:00:00.00')
    expect(toAssTime(1500)).toBe('0:00:01.50')
    expect(toAssTime(61_230)).toBe('0:01:01.23')
    expect(toAssTime(3_661_000)).toBe('1:01:01.00')
  })

  it('clamps negatives rather than emitting an invalid timestamp', () => {
    expect(toAssTime(-500)).toBe('0:00:00.00')
  })
})

describe('groupWords', () => {
  it('chunks by words-per-line', () => {
    const groups = groupWords(SEGMENTS, SAMPLE, 2)
    expect(groups[0].map((w) => w.text)).toEqual(['And', 'so'])
    expect(groups[1].map((w) => w.text)).toEqual(['my', 'fellow'])
  })

  it('never lets a group straddle a segment boundary', () => {
    const groups = groupWords(SEGMENTS, SAMPLE, 4)
    for (const group of groups) {
      const owning = SEGMENTS.filter(
        (s) => group[0].index >= s.wordStart && group[0].index <= s.wordEnd
      )
      expect(owning).toHaveLength(1)
      for (const word of group) {
        expect(word.index).toBeGreaterThanOrEqual(owning[0].wordStart)
        expect(word.index).toBeLessThanOrEqual(owning[0].wordEnd)
      }
    }
  })
})

describe('buildAss', () => {
  it('emits a valid script header with the real canvas size', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, opts)
    expect(ass).toContain('[Script Info]')
    expect(ass).toContain('ScriptType: v4.00+')
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toContain('[V4+ Styles]')
    expect(ass).toContain('[Events]')
  })

  it('scales type against the 1080p reference so styles hold across aspects', () => {
    const tall = buildAss(SEGMENTS, SAMPLE, { ...opts, width: 1080, height: 1920 })
    const wide = buildAss(SEGMENTS, SAMPLE, { ...opts, width: 1920, height: 1080 })

    const sizeOf = (ass: string): number =>
      Number(ass.split('\n').find((l) => l.startsWith('Style: Default'))!.split(',')[2])

    expect(sizeOf(wide)).toBe(DEFAULT_CAPTION_STYLE.fontSize)
    // 1920 tall is 1.777x the reference, so type scales with it.
    expect(sizeOf(tall)).toBe(Math.round(DEFAULT_CAPTION_STYLE.fontSize * (1920 / REFERENCE_HEIGHT)))
  })

  it('emits one event per word so the active word can be recoloured and scaled', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, opts)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events).toHaveLength(SAMPLE.length)
  })

  it('highlights exactly one word per event', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, opts)
    const highlight = toAssColor(DEFAULT_CAPTION_STYLE.highlightColor)
    for (const line of ass.split('\n').filter((l) => l.startsWith('Dialogue:'))) {
      expect(line.split(highlight).length - 1).toBe(1)
    }
  })

  it('holds a word until the next begins, so the line does not flicker', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, opts)
    const first = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    // "And" ends at 400 but "so" starts at 400, so the cue runs to 0:00:00.40.
    expect(first).toContain('0:00:00.00,0:00:00.40')
  })

  it('uppercases when the style asks for it', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, opts)
    expect(ass).toContain('FELLOW')
    expect(ass).not.toMatch(/}fellow /)
  })

  it('shifts cues by the offset for a trimmed clip', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, { ...opts, offsetMs: 800 })
    // "my" starts at 800ms of source, which is 0 once the clip starts there.
    expect(ass).toContain('0:00:00.00')
    // Words fully before the offset must not produce negative-time cues.
    for (const line of ass.split('\n').filter((l) => l.startsWith('Dialogue:'))) {
      expect(line).not.toContain('-')
    }
  })

  it('drops cues outside the clip range', () => {
    const ass = buildAss(SEGMENTS, SAMPLE, { ...opts, rangeMs: { startMs: 0, endMs: 1200 } })
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events.length).toBeLessThan(SAMPLE.length)
    expect(ass).not.toContain('AMERICANS')
  })

  it('escapes braces so literal text cannot inject override tags', () => {
    const tricky = words([['{\\an8}hack', 0, 500]])
    const ass = buildAss(segmentIntoSentences(tricky), tricky, opts)
    const event = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(event).toContain('\\{')
    expect(event).not.toMatch(/\{\\an8\}/)
  })

  it('produces no events for an empty transcript', () => {
    const ass = buildAss([], [], opts)
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(0)
  })
})

describe('caption styles', () => {
  it('resolves by id and falls back to the default', () => {
    expect(styleById('clean').id).toBe('clean')
    expect(styleById('nope').id).toBe(DEFAULT_CAPTION_STYLE.id)
  })

  it('every style names a font the asset catalog can supply', () => {
    for (const style of CAPTION_STYLES) {
      expect(style.fontFamily.length).toBeGreaterThan(0)
      expect(style.wordsPerLine).toBeGreaterThan(0)
    }
  })
})

describe('style overrides', () => {
  it('layers overrides onto the preset', () => {
    const style = resolveStyle('pop', { fontFamily: 'Bangers', fontSize: 120 })
    expect(style.fontFamily).toBe('Bangers')
    expect(style.fontSize).toBe(120)
    // Untouched fields keep the preset's values, so improving a preset still
    // reaches projects that only changed the font.
    expect(style.highlightColor).toBe(DEFAULT_CAPTION_STYLE.highlightColor)
  })

  it('returns the preset unchanged when there are no overrides', () => {
    expect(resolveStyle('clean')).toEqual(styleById('clean'))
    expect(resolveStyle('clean', {})).toEqual(styleById('clean'))
  })

  it('guards values the renderer divides or scales by', () => {
    const style = resolveStyle('pop', {
      fontSize: -10,
      wordsPerLine: 0,
      highlightScale: 0,
      outlineWidth: -5
    })
    expect(style.fontSize).toBeGreaterThan(0)
    expect(style.wordsPerLine).toBeGreaterThanOrEqual(1)
    expect(style.highlightScale).toBeGreaterThan(0)
    expect(style.outlineWidth).toBeGreaterThanOrEqual(0)
  })

  it('produces a usable ASS file from an overridden style', () => {
    const style = resolveStyle('pop', { fontFamily: 'Bangers', uppercase: false })
    const ass = buildAss(SEGMENTS, SAMPLE, { width: 1080, height: 1920, style })
    expect(ass).toContain('Style: Default,Bangers,')
    expect(ass).toContain('fellow')
  })
})
