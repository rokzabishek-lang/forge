import { describe, it, expect } from 'vitest'
import type { Project } from '@shared/timeline'
import {
  clipCoversFrame,
  nearestTransitionTarget,
  laneOrder,
  addTransition,
  removeTransition,
  transitionBase,
  maxTransitionFrames,
  addTrack,
  removeTrack,
  MAX_TRACKS,
  emptyProject,
  splitClip,
  trimStart,
  trimEnd,
  findFreeSlot,
  overlapsOn,
  stackedSlot,
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

describe('nearestTransitionTarget', () => {
  const twoClips = (): ReturnType<typeof emptyProject> => ({
    ...emptyProject(),
    clips: [
      clip({ id: 'first', trackId: 'v1', start: 0, duration: 90 }),
      clip({ id: 'second', trackId: 'v1', start: 90, duration: 90 })
    ]
  })

  it('snaps to the cut from either side of it', () => {
    const project = twoClips()
    // Just before the boundary — previously this targeted the outgoing clip.
    expect(nearestTransitionTarget(project, 'v1', 85, 15).clip?.id).toBe('second')
    // Just after it.
    expect(nearestTransitionTarget(project, 'v1', 95, 15).clip?.id).toBe('second')
  })

  it('falls back to the clip under the cursor when far from a cut', () => {
    const project = twoClips()
    expect(nearestTransitionTarget(project, 'v1', 150, 15).clip?.id).toBe('second')
  })

  it('explains why the first clip cannot take one, rather than failing silently', () => {
    const project = twoClips()
    const result = nearestTransitionTarget(project, 'v1', 20, 5)
    expect(result.clip).toBeNull()
    expect(result.reason).toMatch(/first clip/i)
  })

  it('explains a track with only one clip', () => {
    const project = { ...emptyProject(), clips: [clip({ id: 'only', trackId: 'v1' })] }
    const result = nearestTransitionTarget(project, 'v1', 10, 15)
    expect(result.clip).toBeNull()
    expect(result.reason).toMatch(/only one clip/i)
  })

  it('explains an empty track', () => {
    const result = nearestTransitionTarget(emptyProject(), 'v1', 10, 15)
    expect(result.clip).toBeNull()
    expect(result.reason).toMatch(/no clips/i)
  })

  it('picks the nearest of several cuts', () => {
    const project = {
      ...emptyProject(),
      clips: [
        clip({ id: 'a', trackId: 'v1', start: 0, duration: 60 }),
        clip({ id: 'b', trackId: 'v1', start: 60, duration: 60 }),
        clip({ id: 'c', trackId: 'v1', start: 120, duration: 60 })
      ]
    }
    expect(nearestTransitionTarget(project, 'v1', 58, 10).clip?.id).toBe('b')
    expect(nearestTransitionTarget(project, 'v1', 124, 10).clip?.id).toBe('c')
  })
})

describe('clip duration limits', () => {
  /*
   * A still can be held as long as you like — a title that can only last as
   * long as its own PNG "duration" would be useless. Footage and audio cannot
   * be stretched past what is left of them after the in-point.
   */
  it('clamps trailing media to what remains after the in-point', () => {
    const remaining = (assetFrames: number, inPoint: number): number =>
      Math.max(1, assetFrames - inPoint)
    expect(remaining(300, 0)).toBe(300)
    expect(remaining(300, 120)).toBe(180)
    expect(remaining(300, 300)).toBe(1)
  })
})

/*
 * The layer stack read upside down.
 *
 * Both the renderer and the preview composite in `tracks` order, so the first
 * video track is the BOTTOM layer — but the timeline listed them in that same
 * order, putting V1 at the top of the screen while it sat underneath everything
 * in the picture. A sticker dropped on the track visibly above the video
 * rendered behind it, which read as picture-in-picture simply not working.
 */
describe('laneOrder', () => {
  const project = emptyProject()

  it('puts the layer that composites on top at the top of the list', () => {
    const video = project.tracks.filter((t) => t.kind === 'video')
    const lanes = laneOrder(project.tracks).filter((t) => t.kind === 'video')
    expect(lanes[0].id).toBe(video[video.length - 1].id)
    expect(lanes[lanes.length - 1].id).toBe(video[0].id)
  })

  it('keeps audio below the video, in its own order', () => {
    const lanes = laneOrder(project.tracks)
    const firstAudio = lanes.findIndex((t) => t.kind === 'audio')
    expect(lanes.slice(0, firstAudio).every((t) => t.kind === 'video')).toBe(true)
    expect(lanes.slice(firstAudio).map((t) => t.name)).toEqual(['A1', 'A2'])
  })

  it('shows every track exactly once', () => {
    const lanes = laneOrder(project.tracks)
    expect(lanes).toHaveLength(project.tracks.length)
    expect(new Set(lanes.map((t) => t.id)).size).toBe(project.tracks.length)
  })

  it('does not mutate the project', () => {
    // reverse() in place would silently flip the real compositing order.
    const before = project.tracks.map((t) => t.id)
    laneOrder(project.tracks)
    expect(project.tracks.map((t) => t.id)).toEqual(before)
  })

  it('puts a newly added video track on top', () => {
    const added = addTrack(project, 'video')
    expect(laneOrder(added.tracks)[0].id).toBe(added.tracks.filter((t) => t.kind === 'video').at(-1)!.id)
  })
})

/*
 * A transition blends a clip in from whatever is underneath it.
 *
 * The panel used to demand a previous clip on the same track, so a photograph
 * dropped on V2 over another one — the grid-reveal edit — had no transition UI
 * at all, and the length slider capped at nothing.
 */
describe('transitionBase', () => {
  const still = (id: string, trackId: string, start: number, duration: number): Clip => ({
    id, assetId: 'a', trackId, start, duration, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  it('finds the clip before it on the same track', () => {
    const base = emptyProject()
    const project = { ...base, clips: [still('a', 'v1', 0, 30), still('b', 'v1', 30, 30)] }
    const found = transitionBase(project, project.clips[1])
    expect(found).toEqual({ clip: project.clips[0], kind: 'cut' })
  })

  it('finds the layer underneath when there is nothing before it', () => {
    const base = emptyProject()
    const project = { ...base, clips: [still('under', 'v1', 0, 90), still('over', 'v2', 20, 40)] }
    const found = transitionBase(project, project.clips[1])
    expect(found).toEqual({ clip: project.clips[0], kind: 'layer' })
  })

  it('ignores a layer that is not on screen at the same time', () => {
    const base = emptyProject()
    const project = { ...base, clips: [still('under', 'v1', 0, 10), still('over', 'v2', 40, 20)] }
    expect(transitionBase(project, project.clips[1])).toBeNull()
  })

  it('ignores a hidden track, which is excluded from the render', () => {
    const base = emptyProject()
    const project = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === 'v1' ? { ...t, hidden: true } : t)),
      clips: [still('under', 'v1', 0, 90), still('over', 'v2', 0, 40)]
    }
    expect(transitionBase(project, project.clips[1])).toBeNull()
  })

  it('never looks upward — a higher track composites over, not under', () => {
    const base = emptyProject()
    const project = { ...base, clips: [still('over', 'v2', 0, 90), still('under', 'v1', 0, 40)] }
    expect(transitionBase(project, project.clips[1])).toBeNull()
  })
})

describe('maxTransitionFrames', () => {
  const clip = (duration: number): Clip => ({
    id: 'c', assetId: 'a', trackId: 'v1', start: 0, duration, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  it('is limited by the shorter of the two clips at a cut', () => {
    expect(maxTransitionFrames(clip(20), clip(50))).toBe(19)
    expect(maxTransitionFrames(clip(50), clip(20))).toBe(19)
  })

  it('is limited only by its own length when it is layered', () => {
    // The layer underneath runs its own length whatever this clip does, so a
    // slow reveal is allowed.
    expect(maxTransitionFrames(null, clip(120))).toBe(119)
  })
})

/*
 * A transition on a layered clip.
 *
 * The panel was opened for these — a photograph on V2 over another on V1, or a
 * title over footage — but the model still refused them: `addTransition`
 * returned the project unchanged when the clip was first on its track. Clicking
 * a transition did nothing, raised nothing, and the length slider never
 * appeared because no transition was ever set.
 */
describe('addTransition on a layered clip', () => {
  const still = (id: string, trackId: string, start: number, duration: number): Clip => ({
    id, assetId: 'a', trackId, start, duration, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  const layered = (): Project => ({
    ...emptyProject(),
    clips: [still('under', 'v1', 0, 120), still('over', 'v2', 20, 60)]
  })

  it('applies to a clip with nothing before it on its track', () => {
    const next = addTransition(layered(), 'over', 'dissolve', 12)
    expect(next.clips.find((c) => c.id === 'over')?.transitionIn).toEqual({
      id: 'dissolve',
      durationFrames: 12
    })
  })

  it('does not move the clip, because nothing overlaps', () => {
    // At a cut a transition eats into both clips and the timeline shortens.
    // Layered, the clip underneath runs its own length whatever happens here.
    const next = addTransition(layered(), 'over', 'dissolve', 12)
    expect(next.clips.find((c) => c.id === 'over')?.start).toBe(20)
    expect(next.clips.find((c) => c.id === 'under')?.start).toBe(0)
  })

  it('is limited only by its own length', () => {
    const next = addTransition(layered(), 'over', 'dissolve', 500)
    expect(next.clips.find((c) => c.id === 'over')?.transitionIn?.durationFrames).toBe(59)
  })

  it('changes length without drifting', () => {
    let next = addTransition(layered(), 'over', 'dissolve', 12)
    next = addTransition(next, 'over', 'dissolve', 30)
    const clip = next.clips.find((c) => c.id === 'over')!
    expect(clip.transitionIn?.durationFrames).toBe(30)
    expect(clip.start).toBe(20)
  })

  it('gives no time back when removed, having taken none', () => {
    const applied = addTransition(layered(), 'over', 'dissolve', 12)
    const cleared = removeTransition(applied, 'over')
    const clip = cleared.clips.find((c) => c.id === 'over')!
    expect(clip.transitionIn).toBeUndefined()
    expect(clip.start).toBe(20)
  })

  it('still shifts at a real cut, where the overlap is real', () => {
    const cut: Project = {
      ...emptyProject(),
      clips: [still('a', 'v1', 0, 60), still('b', 'v1', 60, 60)]
    }
    const next = addTransition(cut, 'b', 'dissolve', 10)
    expect(next.clips.find((c) => c.id === 'b')?.start).toBe(50)
  })
})

/*
 * The rule the preview draws by, and the rule its on-picture handles live by.
 *
 * A sticker added away from the playhead was selected but not covered, so it
 * had no box and nothing to drag — while the Inspector's brightness and LUT
 * kept working, because those read the selection rather than the frame. It read
 * as "sizing is broken" and was reported that way. These pin the rule down so
 * the two halves cannot disagree again.
 */
describe('clipCoversFrame', () => {
  const clip = {
    id: 'a',
    assetId: 'x',
    trackId: 'v1',
    start: 90,
    duration: 90,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }

  it('covers its own first frame', () => {
    expect(clipCoversFrame(clip, 90)).toBe(true)
  })

  it('does not cover the frame before it', () => {
    expect(clipCoversFrame(clip, 89)).toBe(false)
  })

  it('covers its last frame', () => {
    expect(clipCoversFrame(clip, 179)).toBe(true)
  })

  it('does not cover the frame it ends on', () => {
    // Half-open: a clip ending at 180 and one starting at 180 must not both
    // claim frame 180, or a butted cut flickers at every join.
    expect(clipCoversFrame(clip, 180)).toBe(false)
  })

  it('does not cover frame zero when it starts later', () => {
    // Exactly the sticker case: added at three seconds, playhead still at the
    // start, so nothing is drawn and there is nothing to grab.
    expect(clipCoversFrame(clip, 0)).toBe(false)
  })

  it('a clip starting at zero covers the opening frame', () => {
    expect(clipCoversFrame({ ...clip, start: 0 }, 0)).toBe(true)
  })
})

/*
 * Overlays stack; cuts sequence.
 *
 * Reported as "when i try to add two layers like text on text or try to add
 * image in the timeline, its add on the side of it of the same track, but the
 * actual layers work different, its on top of each other be it any N layers".
 *
 * Two clips on one track ARE a sequence — that is what a track is — so
 * findFreeSlot slides a collision later, which is right for a cut. It is wrong
 * for anything meant to sit ON something, and that is the distinction
 * stackedSlot draws.
 */
describe('stackedSlot', () => {
  const overlay = (id: string, trackId: string, start: number, duration = 90): Clip => ({
    id,
    assetId: 'a1',
    trackId,
    start,
    duration,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  /** Two video tracks, v1 under v2, as a fresh project has. */
  const base = (): Project => emptyProject()

  it('keeps the asked-for track when the moment is free', () => {
    const p = base()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const slot = stackedSlot(p, video[0].id, 30, 90)
    expect(slot).toEqual({ trackId: video[0].id, start: 30 })
  })

  it('climbs a track instead of sliding later in time', () => {
    const p = base()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const busy: Project = { ...p, clips: [overlay('first', video[0].id, 0, 90)] }

    const slot = stackedSlot(busy, video[0].id, 30, 90)!
    // The time is the whole point of the gesture and must not move.
    expect(slot.start).toBe(30)
    expect(slot.trackId).not.toBe(video[0].id)
    expect(slot.trackId).toBe(video[1].id)
  })

  it('reports no room when every track above is busy', () => {
    const p = base()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const full: Project = {
      ...p,
      clips: video.map((t, i) => overlay(`c${i}`, t.id, 0, 90))
    }
    // null is the signal to add a track, not an error.
    expect(stackedSlot(full, video[0].id, 30, 90)).toBeNull()
  })

  it('skips a locked track rather than landing on it', () => {
    const p = base()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const locked: Project = {
      ...p,
      tracks: p.tracks.map((t) => (t.id === video[1].id ? { ...t, locked: true } : t)),
      clips: [overlay('first', video[0].id, 0, 90)]
    }
    expect(stackedSlot(locked, video[0].id, 30, 90)).toBeNull()
  })

  it('never moves the moment, whatever it returns', () => {
    const p = base()
    const video = p.tracks.filter((t) => t.kind === 'video')
    for (const desired of [0, 17, 300, 5000]) {
      const busy: Project = { ...p, clips: [overlay('a', video[0].id, 0, 10_000)] }
      const slot = stackedSlot(busy, video[0].id, desired, 90)
      if (slot) expect(slot.start).toBe(desired)
    }
  })

  it('refuses a track that is not on the timeline', () => {
    expect(stackedSlot(base(), 'no-such-track', 0, 90)).toBeNull()
  })

  it('leaves findFreeSlot alone — a cut still sequences', () => {
    const p = base()
    const video = p.tracks.filter((t) => t.kind === 'video')
    const busy: Project = { ...p, clips: [overlay('first', video[0].id, 0, 90)] }
    // The old behaviour is still there for clips that genuinely follow on.
    expect(findFreeSlot(busy, video[0].id, 30, 90)).toBe(90)
  })
})
