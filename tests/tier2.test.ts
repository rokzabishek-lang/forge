import { describe, it, expect } from 'vitest'
import { buildGraphicsSpec, needsFrameServer } from '@shared/graphics/fromTimeline'
import { segmentIntoSentences, type Word } from '@shared/transcript'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { layersAt, transformAt } from '@shared/graphics/spec'

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

describe('tier routing', () => {
  it('sends an animated style to the frame server', () => {
    expect(needsFrameServer(project())).toBe(true)
  })

  it('keeps a plain style on the cheap path', () => {
    expect(needsFrameServer(project({ captions: { enabled: true, styleId: 'pop' } }))).toBe(false)
  })

  it('needs nothing when captions are off', () => {
    expect(needsFrameServer(project({ captions: { enabled: false, styleId: 'kinetic' } }))).toBe(false)
  })

  it('needs nothing when there is no transcript', () => {
    expect(needsFrameServer(project({ transcripts: {} }))).toBe(false)
  })

  it('respects an override that turns animation on', () => {
    const p = project({ captions: { enabled: true, styleId: 'pop', overrides: { animated: true } } })
    expect(needsFrameServer(p)).toBe(true)
  })
})

describe('buildGraphicsSpec', () => {
  it('emits one layer per word, which is why this needs tier 2', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    expect(spec.layers).toHaveLength(SAMPLE.length)
    // ASS can recolour per word but cannot scale per word; separate layers are
    // what make an individual entry curve possible.
    expect(new Set(spec.layers.map((l) => l.id)).size).toBe(SAMPLE.length)
  })

  it('uses the canvas it is given, not the project settings', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    expect(spec.width).toBe(1080)
    expect(spec.height).toBe(1920)
  })

  it('scales type against the 1080p reference', () => {
    const tall = buildGraphicsSpec(project(), { width: 1080, height: 1920 })!
    const wide = buildGraphicsSpec(project(), { width: 1920, height: 1080 })!
    const sizeOf = (s: typeof tall): number => (s.layers[0] as { fontSize: number }).fontSize
    expect(sizeOf(tall)).toBeCloseTo(sizeOf(wide) * (1920 / 1080), 3)
  })

  it('maps source time to timeline frames through the clip in-point', () => {
    // Clip reads from 2s of source, so "Word" at 2000ms lands at frame 0.
    const spec = buildGraphicsSpec(project({}, { inPoint: 60, duration: 60 }), CANVAS)!
    expect(spec.layers[0].startFrame).toBe(0)
    // Words before the in-point must not appear.
    const texts = spec.layers.flatMap((l) => (l.kind === 'text' ? [l.text.toLowerCase()] : []))
    expect(texts.some((t) => t.includes('this'))).toBe(false)
  })

  it('gives each word an entry animation that settles to rest', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    const layer = spec.layers[0]
    const atStart = transformAt(layer.transform, layer.startFrame)
    const settled = transformAt(layer.transform, layer.startFrame + 20)
    expect(atStart.opacity).toBe(0)
    expect(atStart.scale).toBeLessThan(1)
    expect(settled.opacity).toBe(1)
    expect(settled.scale).toBeCloseTo(1, 3)
  })

  it('keeps a whole group on screen together', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    // Mid-way through the first group, every word of it should be live.
    const live = layersAt(spec, 20)
    expect(live.length).toBeGreaterThan(1)
  })

  it('offsets words horizontally so they do not stack', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    const xs = spec.layers.slice(0, 3).map((l) => l.transform.x)
    expect(new Set(xs).size).toBeGreaterThan(1)
  })

  it('returns null when there is nothing to draw', () => {
    expect(buildGraphicsSpec(project({ transcripts: {} }), CANVAS)).toBeNull()
  })

  it('runs to the last word, not the whole timeline', () => {
    const spec = buildGraphicsSpec(project(), CANVAS)!
    expect(spec.durationFrames).toBe(Math.max(...spec.layers.map((l) => l.endFrame)))
  })
})
