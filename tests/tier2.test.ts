import { describe, it, expect } from 'vitest'
import {
  buildGraphicsSpec,
  captionsNeedBaking,
  needsFrameServer
} from '@shared/graphics/fromTimeline'
import { segmentIntoSentences, type Word } from '@shared/transcript'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { layersAt, type CaptionLayer } from '@shared/graphics/spec'
import {
  transitionsFromMasks,
  familyForMaskName,
  lumaAlphaExpression
} from '@shared/transitions/registry'

function words(spec: [string, number, number][]): Word[] {
  return spec.map(([text, startMs, endMs], index) => ({ index, text, startMs, endMs, confidence: 0.9 }))
}

const SAMPLE = words([
  ['This', 0, 500], ['is', 500, 900], ['Forge.', 900, 1600],
  ['Word', 2000, 2400], ['by', 2400, 2700], ['word.', 2700, 3300]
])

function project(over: Partial<Project> = {}, clipOver: Partial<Clip> = {}): Project {
  const asset: MediaAsset = {
    id: 'a1', path: '/m/a.mp4', name: 'a.mp4', kind: 'video', durationFrames: 150,
    width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: 120, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...clipOver
  }
  return {
    ...emptyProject(),
    assets: [asset],
    clips: [clip],
    transcripts: {
      a1: { assetId: 'a1', language: 'en', model: 'test', durationMs: 4000, words: SAMPLE, segments: segmentIntoSentences(SAMPLE) }
    },
    captions: { enabled: true, styleId: 'kinetic' },
    ...over
  }
}

const CANVAS = { width: 1080, height: 1920 }

describe('caption routing', () => {
  /*
   * Which of two paths a caption takes, and it is never both.
   *
   * libass burns a flat caption in during the normal encode at no extra cost,
   * so it stays the answer for anything it can express. A gradient, a glow or a
   * per-word ease it cannot, and those are baked to pictures in the renderer
   * and composited as one more overlay in the SAME pass. Nothing goes to the
   * offscreen frame server any more — that was the second encode.
   */
  it('bakes a style libass cannot draw', () => {
    expect(captionsNeedBaking(project())).toBe(true)
  })

  it('burns a plain style in, which is free', () => {
    expect(captionsNeedBaking(project({ captions: { enabled: true, styleId: 'pop' } }))).toBe(false)
  })

  it('does neither when captions are off', () => {
    expect(
      captionsNeedBaking(project({ captions: { enabled: false, styleId: 'kinetic' } }))
    ).toBe(false)
  })

  it('does neither when there is no transcript', () => {
    expect(captionsNeedBaking(project({ transcripts: {} }))).toBe(false)
  })

  it('respects an override that turns a look on', () => {
    const p = project({
      captions: { enabled: true, styleId: 'pop', overrides: { textStyleId: 'chrome' } }
    })
    expect(captionsNeedBaking(p)).toBe(true)
  })

  it('never sends anything to the frame server', () => {
    // The two-pass path is gone: it cost roughly five times the render itself.
    expect(needsFrameServer(project())).toBe(false)
    expect(needsFrameServer(project({ captions: { enabled: true, styleId: 'pop' } }))).toBe(false)
  })
})

describe('buildGraphicsSpec', () => {
  /** Caption layers, which is all this builds. */
  const captions = (spec: ReturnType<typeof buildGraphicsSpec>): CaptionLayer[] =>
    (spec?.layers ?? []).flatMap((l) => (l.kind === 'caption' ? [l] : []))

  it('emits one layer per LINE, not one per word', () => {
    /*
     * The old build made a layer per word and placed each one by assuming a word
     * is 2.2 font sizes wide, which is not true of any real font — every caption
     * came out slightly mis-spaced and no style could fix it. A line is one
     * layer now, and the painter measures it.
     */
    const spec = buildGraphicsSpec(project(), CANVAS)!
    const lines = captions(spec)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThan(SAMPLE.length)
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length)
  })

  it('carries the whole line as text', () => {
    const [first] = captions(buildGraphicsSpec(project(), CANVAS)!)
    expect(first.spec.content).toBe('This is Forge.')
  })

  it('says when each word becomes the spoken one', () => {
    const [first] = captions(buildGraphicsSpec(project(), CANVAS)!)
    // One per word of the line, in reading order, never going backwards.
    expect(first.wordFrames).toHaveLength(first.spec.content.split(' ').length)
    for (let i = 1; i < first.wordFrames.length; i++) {
      expect(first.wordFrames[i]).toBeGreaterThanOrEqual(first.wordFrames[i - 1])
    }
  })

  it('leaves the highlight off the spec, because it moves', () => {
    // Baking an index into the layer would freeze the caption on one word.
    const [first] = captions(buildGraphicsSpec(project(), CANVAS)!)
    expect(first.spec.highlight).toBeUndefined()
    expect(first.highlight?.color).toBeTruthy()
  })

  it('uses the canvas it is given, not the project settings', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    expect(spec.width).toBe(1080)
    expect(spec.height).toBe(1920)
  })

  it('sizes type as a fraction, so one style fits any frame', () => {
    // The old spec carried pixels and had to be scaled per canvas. A fraction of
    // the height is the same number in 9:16 and 16:9 and resolves later.
    const tall = captions(buildGraphicsSpec(project(), { width: 1080, height: 1920 })!)
    const wide = captions(buildGraphicsSpec(project(), { width: 1920, height: 1080 })!)
    expect(tall[0].spec.size).toBeCloseTo(wide[0].spec.size, 6)
    expect(tall[0].spec.size).toBeGreaterThan(0)
    expect(tall[0].spec.size).toBeLessThan(0.3)
  })

  it('maps source time to timeline frames through the clip in-point', () => {
    // Clip reads from 2s of source, so "Word" at 2000ms lands at frame 0.
    const lines = captions(buildGraphicsSpec(project({}, { inPoint: 60, duration: 60 }), CANVAS)!)
    expect(lines[0].startFrame).toBe(0)
    // Words before the in-point must not appear.
    const said = lines.map((l) => l.spec.content.toLowerCase()).join(' ')
    expect(said).not.toContain('this')
  })

  it('never runs a line past the clip showing it', () => {
    const lines = captions(buildGraphicsSpec(project({}, { inPoint: 60, duration: 60 }), CANVAS)!)
    for (const line of lines) expect(line.endFrame).toBeLessThanOrEqual(60)
  })

  it('keeps a whole line on screen together', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    // Mid-way through the first line, it is one live layer carrying every word.
    const live = layersAt(spec, 20)
    expect(live).toHaveLength(1)
    expect((live[0] as CaptionLayer).spec.content.split(' ').length).toBeGreaterThan(1)
  })

  it('carries the chosen look and animation onto every line', () => {
    const p = project({
      captions: {
        enabled: true,
        styleId: 'pop',
        overrides: { textStyleId: 'chrome', animationId: 'pop' }
      }
    })
    for (const line of captions(buildGraphicsSpec(p, CANVAS)!)) {
      expect(line.spec.styleId).toBe('chrome')
      expect(line.spec.animationId).toBe('pop')
    }
  })

  it('returns null when there is nothing to draw', () => {
    expect(buildGraphicsSpec(project({ transcripts: {} }), CANVAS)).toBeNull()
  })

  it('runs to the last word, not the whole timeline', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    expect(spec.durationFrames).toBe(Math.max(...spec.layers.map((l) => l.endFrame)))
  })
})

describe('mask transitions', () => {
  const masks = [
    { id: 'transition:extra-barr-ripple-1-jpg', name: 'barr ripple 1', file: 'transitions/extra/barr_ripple_1.jpg' },
    { id: 'transition:extra-glitch-3-jpg', name: 'glitch 3', file: 'transitions/extra/glitch_3.jpg' },
    { id: 'transition:extra-light-leak-jpg', name: 'light leak', file: 'transitions/extra/light_leak.jpg' },
    { id: 'transition:extra-4-squares-jpg', name: '4 squares left barr', file: 'transitions/extra/4_squares.jpg' }
  ]

  it('turns catalog masks into tier-1 transitions', () => {
    const built = transitionsFromMasks(masks)
    expect(built).toHaveLength(4)
    // Masks are plain ffmpeg — alphamerge with a geq-animated mask — so they
    // must not drag a render onto the frame server.
    expect(built.every((t) => t.tier === 1)).toBe(true)
    expect(built.every((t) => Boolean(t.mask))).toBe(true)
  })

  it('groups masks into families so the picker is navigable', () => {
    expect(familyForMaskName('barr ripple 1')).toBe('smooth')
    expect(familyForMaskName('glitch 3')).toBe('glitch')
    expect(familyForMaskName('light leak')).toBe('light')
    expect(familyForMaskName('4 squares left barr')).toBe('wipe')
  })

  it('falls back to a family rather than dropping an unrecognised mask', () => {
    expect(familyForMaskName('zzz unknown thing')).toBe('dissolve')
  })
})

describe('luma alpha expression', () => {
  it('sweeps a threshold across the mask over the transition', () => {
    const expression = lumaAlphaExpression(1)
    expect(expression).toContain('T/1.0000')
    expect(expression).toContain('p(X,Y)')
    // Clipping is what makes the wipe saturate instead of fading back out once
    // the transition is over — the mask input outlives the wipe.
    expect(expression).toMatch(/^clip\(/)
  })

  it('never divides by zero for a degenerate duration', () => {
    expect(() => lumaAlphaExpression(0)).not.toThrow()
    expect(lumaAlphaExpression(0)).not.toContain('/0.0000')
  })

  it('widens the soft edge when asked', () => {
    expect(lumaAlphaExpression(1, 60)).toContain('60')
  })
})
