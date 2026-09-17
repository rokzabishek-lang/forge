import { describe, it, expect } from 'vitest'
import {
  PROP_RULE,
  clearGenerated,
  generatedCount,
  overlayTrackFor,
  planPropClips,
  makeGeneratedClip
} from '@shared/automation/apply'
import { tagsForProp, DEFAULT_TRIGGER_OPTIONS, type PropTrigger } from '@shared/automation/keywords'
import { segmentIntoSentences, type Word } from '@shared/transcript'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

function words(spec: [string, number][]): Word[] {
  return spec.map(([text, startMs], index) => ({ index, text, startMs, endMs: startMs + 300, confidence: 0.9 }))
}

const SPOKEN: [string, number][] = [
  ['we', 0], ['need', 400], ['fire', 1000], ['and', 1400],
  ['a', 1800], ['rocket', 2200], ['to', 2600], ['launch', 3000]
]

function project(clipOver: Partial<Clip> = {}): Project {
  const asset: MediaAsset = {
    id: 'a1', path: '/m/a.mp4', name: 'a.mp4', kind: 'video', durationFrames: 300,
    width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: 150, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...clipOver
  }
  const w = words(SPOKEN)
  return {
    ...emptyProject(),
    assets: [asset],
    clips: [clip],
    transcripts: {
      a1: { assetId: 'a1', language: 'en', model: 'test', durationMs: 60_000, words: w, segments: segmentIntoSentences(w) }
    }
  }
}

const triggers: PropTrigger[] = [
  { assetId: 'fire', file: 'props_3d/fire_3d.png', name: 'fire', tags: tagsForProp('fire') },
  { assetId: 'rocket', file: 'props_3d/rocket_3d.png', name: 'rocket', tags: tagsForProp('rocket') }
]
const options = { ...DEFAULT_TRIGGER_OPTIONS, fps: 30 }

describe('planPropClips', () => {
  it('places a prop at the frame its word is spoken', () => {
    const planned = planPropClips(project(), triggers, options, 45)
    // "fire" at 1000ms with a clip starting at frame 0 = frame 30.
    expect(planned[0]).toMatchObject({ name: 'fire', startFrame: 30 })
  })

  it('maps through a trimmed clip, not raw source time', () => {
    // Clip reads from 1s of source and sits at frame 60 of the timeline.
    const planned = planPropClips(project({ inPoint: 30, start: 60 }), triggers, options, 45)
    // "fire" at 1000ms is the clip's first frame, so it lands at 60.
    expect(planned[0].startFrame).toBe(60)
  })

  it('ignores hits outside the portion of source the clip shows', () => {
    // Clip shows only the first second, so "rocket" at 2200ms is not visible.
    const planned = planPropClips(project({ duration: 30 }), triggers, options, 45)
    expect(planned.some((p) => p.name === 'rocket')).toBe(false)
  })

  it('records why each one fired', () => {
    const planned = planPropClips(project(), triggers, options, 45)
    expect(planned[0].reason).toMatch(/"fire" matched fire/)
  })

  it('returns clips in timeline order', () => {
    const planned = planPropClips(project(), triggers, options, 45)
    const starts = planned.map((p) => p.startFrame)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('does nothing without a transcript', () => {
    expect(planPropClips({ ...project(), transcripts: {} }, triggers, options, 45)).toEqual([])
  })
})

describe('generated clip bookkeeping', () => {
  const withGenerated = (): Project => {
    const base = project()
    return {
      ...base,
      clips: [
        ...base.clips,
        makeGeneratedClip({
          id: 'g1', assetId: 'a1', trackId: 'v2', startFrame: 30,
          durationFrames: 45, rule: PROP_RULE, reason: 'test'
        })
      ]
    }
  }

  it('counts only its own output', () => {
    expect(generatedCount(withGenerated(), PROP_RULE)).toBe(1)
    expect(generatedCount(withGenerated(), 'other.rule')).toBe(0)
  })

  it('clears its own output and leaves hand-made clips alone', () => {
    const cleared = clearGenerated(withGenerated(), PROP_RULE)
    expect(cleared.clips.map((c) => c.id)).toEqual(['c1'])
  })

  it('leaves another rule untouched', () => {
    const cleared = clearGenerated(withGenerated(), 'other.rule')
    expect(cleared.clips).toHaveLength(2)
  })

  it('marks provenance so the UI can explain itself', () => {
    const clip = withGenerated().clips[1]
    expect(clip.generatedBy).toEqual({ rule: PROP_RULE, reason: 'test' })
  })
})

describe('overlayTrackFor', () => {
  it('uses the topmost video track, so overlays land above the footage', () => {
    expect(overlayTrackFor(emptyProject())?.id).toBe('v2')
  })

  it('skips locked tracks', () => {
    const base = emptyProject()
    const locked = { ...base, tracks: base.tracks.map((t) => (t.id === 'v2' ? { ...t, locked: true } : t)) }
    expect(overlayTrackFor(locked)?.id).toBe('v1')
  })

  it('returns null when there is nowhere to put them', () => {
    expect(overlayTrackFor({ ...emptyProject(), tracks: [] })).toBeNull()
  })
})
