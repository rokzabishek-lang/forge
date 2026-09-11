import { describe, it, expect } from 'vitest'
import {
  addTrack,
  removeTrack,
  MAX_TRACKS,
  emptyProject,
  splitClip,
  trimStart,
  trimEnd,
  findFreeSlot,
  overlapsOn,
  formatTimecode,
  clipsAtFrame,
  sourceFrameFor,
  type Clip
} from '@shared/timeline'

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    assetId: 'a1',
    trackId: 'v1',
    start: 100,
    duration: 50,
    inPoint: 10,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

describe('formatTimecode', () => {
  it('formats hours, minutes, seconds and frames', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
    expect(formatTimecode(29, 30)).toBe('00:00:00:29')
    expect(formatTimecode(30, 30)).toBe('00:00:01:00')
    expect(formatTimecode(30 * 61 + 7, 30)).toBe('00:01:01:07')
    expect(formatTimecode(30 * 3661, 30)).toBe('01:01:01:00')
  })
})

describe('splitClip', () => {
  it('splits into two halves that tile the original exactly', () => {
    const c = clip()
    const [left, right] = splitClip(c, 120)!
    expect(left.start).toBe(100)
    expect(left.duration).toBe(20)
    expect(right.start).toBe(120)
    expect(right.duration).toBe(30)
    // No frame gained or lost.
    expect(left.duration + right.duration).toBe(c.duration)
  })

  it('advances the source in-point of the right half', () => {
    const [, right] = splitClip(clip(), 120)!
    // 20 frames into the clip means 20 frames further into the source.
    expect(right.inPoint).toBe(30)
  })

  it('refuses to split on or outside the clip edges', () => {
    expect(splitClip(clip(), 100)).toBeNull()
    expect(splitClip(clip(), 150)).toBeNull()
    expect(splitClip(clip(), 42)).toBeNull()
  })
})

describe('trimStart', () => {
  it('keeps content anchored: pulling the head in advances the source', () => {
    const c = clip()
    const t = trimStart(c, 110)
    expect(t.start).toBe(110)
    expect(t.duration).toBe(40)
    expect(t.inPoint).toBe(20)
    // The frame shown at timeline position 120 is unchanged by the trim.
    expect(sourceFrameFor(t, 120)).toBe(sourceFrameFor(c, 120))
  })

  it('cannot extend earlier than the start of the source media', () => {
    // inPoint is 10, so the head can move back at most 10 frames.
    const t = trimStart(clip(), 50)
    expect(t.start).toBe(90)
    expect(t.inPoint).toBe(0)
  })

  it('always leaves at least one frame', () => {
    const t = trimStart(clip(), 999)
    expect(t.duration).toBeGreaterThanOrEqual(1)
  })
})

describe('trimEnd', () => {
  it('cannot run past the end of the source media', () => {
    // inPoint 10 into a 100-frame source leaves 90 frames available.
    const t = trimEnd(clip(), 500, 100)
    expect(t.duration).toBe(90)
  })

  it('always leaves at least one frame', () => {
    expect(trimEnd(clip(), 0, 100).duration).toBe(1)
  })
})

describe('overlap handling', () => {
  it('detects touching clips as non-overlapping', () => {
    const project = { ...emptyProject(), clips: [clip({ id: 'a', start: 0, duration: 100 })] }
    // A clip starting exactly where the other ends is legal.
    expect(overlapsOn(project, 'v1', 100, 50)).toHaveLength(0)
    expect(overlapsOn(project, 'v1', 99, 50)).toHaveLength(1)
  })

  it('finds the next free slot after a collision', () => {
    const project = {
      ...emptyProject(),
      clips: [
        clip({ id: 'a', start: 0, duration: 100 }),
        clip({ id: 'b', start: 100, duration: 100 })
      ]
    }
    expect(findFreeSlot(project, 'v1', 50, 30)).toBe(200)
  })

  it('ignores the clip being moved', () => {
    const project = { ...emptyProject(), clips: [clip({ id: 'a', start: 0, duration: 100 })] }
    expect(findFreeSlot(project, 'v1', 0, 100, 'a')).toBe(0)
  })
})

describe('clipsAtFrame', () => {
  it('returns clips in track order, bottom track first', () => {
    const base = emptyProject()
    const project = {
      ...base,
      tracks: [
        { id: 'v1', kind: 'video' as const, name: 'V1', muted: false, hidden: false, locked: false },
        { id: 'v2', kind: 'video' as const, name: 'V2', muted: false, hidden: false, locked: false }
      ],
      clips: [
        clip({ id: 'top', trackId: 'v2', start: 0, duration: 100 }),
        clip({ id: 'bottom', trackId: 'v1', start: 0, duration: 100 })
      ]
    }
    expect(clipsAtFrame(project, 50).map((c) => c.id)).toEqual(['bottom', 'top'])
  })

  it('treats the end frame as exclusive', () => {
    const project = { ...emptyProject(), clips: [clip({ start: 0, duration: 100 })] }
    expect(clipsAtFrame(project, 99)).toHaveLength(1)
    expect(clipsAtFrame(project, 100)).toHaveLength(0)
  })
})

describe('track management', () => {
  it('starts with two video and two audio tracks', () => {
    const project = emptyProject()
    expect(project.tracks.filter((t) => t.kind === 'video')).toHaveLength(2)
    expect(project.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)
  })

  it('keeps video tracks ahead of audio, because render order depends on it', () => {
    const project = addTrack(addTrack(emptyProject(), 'audio'), 'video')
    const kinds = project.tracks.map((t) => t.kind)
    expect(kinds.indexOf('audio')).toBeGreaterThan(kinds.lastIndexOf('video'))
  })

  it('names new tracks in sequence', () => {
    const project = addTrack(emptyProject(), 'video')
    expect(project.tracks.filter((t) => t.kind === 'video').map((t) => t.name))
      .toEqual(['V1', 'V2', 'V3'])
  })

  it('refuses to exceed the track cap', () => {
    let project = emptyProject()
    for (let i = 0; i < 50; i++) project = addTrack(project, 'video')
    expect(project.tracks.length).toBe(MAX_TRACKS)
  })

  it('removes a track along with its clips', () => {
    const base = emptyProject()
    const project = {
      ...base,
      clips: [clip({ id: 'keep', trackId: 'v1' }), clip({ id: 'drop', trackId: 'v2' })]
    }
    const after = removeTrack(project, 'v2')
    expect(after.tracks.some((t) => t.id === 'v2')).toBe(false)
    expect(after.clips.map((c) => c.id)).toEqual(['keep'])
  })

  it('never removes the last video track, which the renderer requires', () => {
    let project = emptyProject()
    project = removeTrack(project, 'v2')
    const after = removeTrack(project, 'v1')
    expect(after.tracks.some((t) => t.kind === 'video')).toBe(true)
  })

  it('ignores an unknown track id', () => {
    const project = emptyProject()
    expect(removeTrack(project, 'nope')).toBe(project)
  })
})
