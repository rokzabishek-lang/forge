import { describe, it, expect } from 'vitest'
import { activeWordAt, captionOffsetY, captionSpec } from '@shared/captions/line'
import { CAPTION_MARGIN, REFERENCE_HEIGHT } from '@shared/captions/ass'
import { styleById, resolveStyle, type CaptionStyle } from '@shared/captions/style'
import { TITLE_SAFE } from '@shared/timeline'
import { textStyleById } from '@shared/render/textStyle'
import { textAnimationById } from '@shared/render/textAnimation'
import type { Word } from '@shared/transcript'
import { captionSourceClip, captionTrack } from '@shared/captions/timeline'
import { emptyProject, type Clip, type Project } from '@shared/timeline'

/*
 * A caption, as a text spec.
 *
 * The point of this module is that there is exactly ONE description of what a
 * caption looks like, and both the preview and the export read it. Two painters
 * is what kept captions flat: every look would have had to be built twice, so it
 * was built once for text clips and captions went without.
 */

function words(list: [string, number, number][]): Word[] {
  return list.map(([text, startMs, endMs], index) => ({
    index,
    text,
    startMs,
    endMs,
    confidence: 1
  }))
}

const LINE = words([
  ['Word', 0, 400],
  ['by', 400, 700],
  ['word.', 700, 1200]
])

const POP = styleById('pop')

describe('captionSpec', () => {
  it('joins the words into one line', () => {
    expect(captionSpec(POP, LINE, -1).content).toBe('Word by word.')
  })

  it('sizes type as a fraction of the frame, not in pixels', () => {
    // A caption style is authored against a 1080-tall reference; a fraction
    // resolves the same way into 1080x1920 and 1920x1080 with no scaling step
    // for anyone to forget.
    expect(captionSpec(POP, LINE, -1).size).toBeCloseTo(POP.fontSize / REFERENCE_HEIGHT, 6)
  })

  it('keeps the caption boundary rather than the title-safe one', () => {
    // Subtitles hold a wider margin than titles: the very edge of a phone frame
    // is where the interface sits.
    expect(captionSpec(POP, LINE, -1).margin).toBe(CAPTION_MARGIN)
    expect(CAPTION_MARGIN).toBeGreaterThan(TITLE_SAFE)
  })

  it('doubles the outline, because canvas centres a stroke', () => {
    /*
     * ASS measures an outline as the band OUTSIDE the glyph; canvas centres the
     * stroke on the glyph's edge and paints half of it over the letter. Without
     * the doubling the same style is visibly thinner on the drawn path than on
     * the burned-in one.
     */
    const spec = captionSpec(POP, LINE, -1)
    expect(spec.stroke).toBeCloseTo((POP.outlineWidth * 2) / POP.fontSize, 6)
  })

  it('lights the word being spoken and nothing else', () => {
    const spec = captionSpec(POP, LINE, 1)
    expect(spec.highlight).toEqual({
      word: 1,
      color: POP.highlightColor,
      scale: POP.highlightScale
    })
  })

  it('leaves the highlight off when no word is active', () => {
    expect(captionSpec(POP, LINE, -1).highlight).toBeUndefined()
  })

  it('carries a chosen look and animation from the same libraries as text clips', () => {
    const styled: CaptionStyle = { ...POP, textStyleId: 'chrome', animationId: 'pop' }
    const spec = captionSpec(styled, LINE, 0)
    // The ids have to resolve, or a caption would silently render unstyled.
    expect(textStyleById(spec.styleId)).not.toBeNull()
    expect(textAnimationById(spec.animationId)).not.toBeNull()
  })

  it('leaves both off by default, so plain captions stay on the cheap path', () => {
    const spec = captionSpec(POP, LINE, -1)
    expect(spec.styleId).toBeUndefined()
    expect(spec.animationId).toBeUndefined()
  })
})

describe('where the caption sits', () => {
  const at = (over: Partial<CaptionStyle>): number => captionOffsetY({ ...POP, ...over })

  it('drops a bottom caption below the title-safe line for a small margin', () => {
    // 5% of the 1080 reference is 54px, so a 40px margin sits LOWER than a title
    // would — a positive offset, which is downward.
    expect(at({ position: 'bottom', marginV: 40 })).toBeGreaterThan(0)
  })

  it('lifts it when the margin is large', () => {
    // The presets all sit well clear of the edge: 220 of 1080 is a fifth of the
    // frame, far above the title-safe line.
    expect(at({ position: 'bottom', marginV: 300 })).toBeLessThan(0)
    expect(at({ position: 'bottom', marginV: POP.marginV })).toBeLessThan(0)
  })

  it('leaves a centred caption alone', () => {
    expect(at({ position: 'center', marginV: 220 })).toBe(0)
  })

  it('mirrors top and bottom around the same inset', () => {
    const margin = 240
    expect(at({ position: 'top', marginV: margin })).toBeCloseTo(
      -at({ position: 'bottom', marginV: margin }),
      9
    )
  })

  it('agrees with the title-safe anchor when the margin matches it', () => {
    const margin = TITLE_SAFE * REFERENCE_HEIGHT
    expect(at({ position: 'bottom', marginV: margin })).toBeCloseTo(0, 9)
  })
})

describe('activeWordAt', () => {
  it('finds the word being spoken', () => {
    expect(activeWordAt(LINE, 500)).toBe(1)
  })

  it('holds a word until the next one starts', () => {
    // A highlight that goes dark in the gaps between words looks broken, and
    // this is also what ASS karaoke does.
    const gapped = words([
      ['one', 0, 200],
      ['two', 800, 1000]
    ])
    expect(activeWordAt(gapped, 500)).toBe(0)
  })

  it('says nothing before the line and after it', () => {
    expect(activeWordAt(LINE, -1)).toBe(-1)
    expect(activeWordAt(LINE, 1200)).toBe(-1)
    expect(activeWordAt(LINE, 9999)).toBe(-1)
  })

  it('lights the first word exactly as it begins', () => {
    expect(activeWordAt(LINE, 0)).toBe(0)
  })

  it('survives an empty line rather than throwing', () => {
    expect(activeWordAt([], 100)).toBe(-1)
  })
})

describe('overrides reach the new fields', () => {
  it('lets a preset be given a look without leaving the preset', () => {
    const resolved = resolveStyle('pop', { textStyleId: 'flames', animationId: 'wave' })
    expect(resolved.textStyleId).toBe('flames')
    expect(resolved.animationId).toBe('wave')
    // And the preset's own values survive underneath.
    expect(resolved.fontFamily).toBe(POP.fontFamily)
  })
})

describe('the caption source, preview and export', () => {
  it('makes the Kinetic preset actually move', () => {
    /*
     * `animated: true` predates the animation library and used to mean "route
     * this to the frame server". Every path that moves type reads animationId,
     * so the preset advertised per-word motion with a badge and rendered
     * perfectly still.
     */
    const kinetic = styleById('kinetic')
    expect(kinetic.animated).toBe(true)
    expect(captionSpec(kinetic, LINE, -1).animationId).toBeTruthy()
  })

  it('lets an explicit animation beat the preset flag', () => {
    const spec = captionSpec({ ...styleById('kinetic'), animationId: 'wave' }, LINE, -1)
    expect(spec.animationId).toBe('wave')
  })

  it('leaves a still preset still', () => {
    expect(captionSpec(styleById('pop'), LINE, -1).animationId).toBeUndefined()
  })
})

describe('which clip captions come from', () => {
  const shot = (id: string, trackId: string, start: number, duration = 90): Clip => ({
    id,
    assetId: 'a-' + id,
    trackId,
    start,
    duration,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  it('reads the bottom video track, not whatever is stacked on top', () => {
    /*
     * The preview used to take the TOPMOST layer at the playhead while the
     * export built from the bottom track — so putting a text card over the
     * picture made captions vanish on screen and still burn into the file.
     */
    const p = emptyProject()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const withOverlay: Project = {
      ...p,
      clips: [shot('picture', video[0].id, 0), shot('textcard', video[1].id, 0)]
    }
    expect(captionSourceClip(withOverlay, 30)?.id).toBe('picture')
  })

  it('follows the timeline, so a gap has no caption source', () => {
    const p = emptyProject()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const gapped: Project = { ...p, clips: [shot('a', video[0].id, 0, 30)] }
    expect(captionSourceClip(gapped, 10)?.id).toBe('a')
    expect(captionSourceClip(gapped, 60)).toBeNull()
  })

  it('has no source at all when there is no visible video track', () => {
    const p = emptyProject()
    const hidden: Project = { ...p, tracks: p.tracks.map((t) => ({ ...t, hidden: true })) }
    expect(captionSourceClip(hidden, 0)).toBeNull()
    expect(captionTrack(hidden)).toBeNull()
  })
})

describe('which track captions come from, when clips move', () => {
  const shot = (id: string, trackId: string, assetId: string): Clip => ({
    id,
    assetId,
    trackId,
    start: 0,
    duration: 90,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  const withTranscript = (p: Project, assetId: string): Project => ({
    ...p,
    transcripts: {
      [assetId]: {
        assetId,
        language: 'en',
        model: 't',
        durationMs: 1000,
        words: [{ index: 0, text: 'hi', startMs: 0, endMs: 500, confidence: 1 }],
        segments: [{ id: 's', wordStart: 0, wordEnd: 0, startMs: 0, endMs: 500, text: 'hi' }]
      }
    }
  })

  it('follows a transcribed clip that was moved up a track', () => {
    /*
     * Stacking overlays is now the ordinary result of adding a second thing at
     * the same moment, so "the transcribed clip is on the bottom track" stopped
     * being a safe assumption. It used to be the only rule, and a clip that had
     * moved silently produced no captions at all.
     */
    const p = emptyProject()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const moved = withTranscript(
      { ...p, clips: [shot('overlay', video[1].id, 'spoken')] },
      'spoken'
    )
    expect(captionTrack(moved)?.id).toBe(video[1].id)
  })

  it('prefers the lower track when both have transcripts', () => {
    // Two tracks captioning at once would be two people talking over each other.
    const p = emptyProject()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const both: Project = {
      ...withTranscript({ ...p, clips: [] }, 'spoken'),
      clips: [shot('low', video[0].id, 'spoken'), shot('high', video[1].id, 'spoken')]
    }
    expect(captionTrack(both)?.id).toBe(video[0].id)
  })

  it('falls back to the lowest visible track when nothing is transcribed', () => {
    const p = emptyProject()
    const video = p.tracks.filter((t) => t.kind === 'video')
    expect(captionTrack(p)?.id).toBe(video[0].id)
  })
})
