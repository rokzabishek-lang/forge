import { describe, it, expect } from 'vitest'
import { crossfadeAt, maxCrossfadeFrames, overlapFrames, emptyProject } from '@shared/timeline'
import type { Clip, MediaAsset, Project } from '@shared/timeline'
import { fadesWithNeighbours } from '@shared/render/audioFade'
import { buildRenderPlan } from '@shared/render/plan'

const FPS = 30

function clip(over: Partial<Clip> & { id: string }): Clip {
  return {
    assetId: 'a',
    trackId: 'a1',
    start: 0,
    duration: FPS * 4,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(clips: Clip[]): Project {
  const sound: MediaAsset = {
    id: 'a', path: '/tmp/a.wav', name: 'a.wav', kind: 'audio', durationFrames: FPS * 20,
    width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 0
  }
  const still: MediaAsset = {
    id: 'p', path: '/tmp/p.png', name: 'p.png', kind: 'image', durationFrames: FPS * 60,
    width: 160, height: 120, fps: null, hasVideo: true, hasAudio: false, size: 0
  }
  return {
    ...emptyProject(),
    settings: { width: 160, height: 120, fps: FPS, sampleRate: 48000 },
    assets: [still, sound],
    clips: [clip({ id: 'pic', assetId: 'p', trackId: 'v1', duration: FPS * 60 }), ...clips]
  }
}

describe('overlapFrames', () => {
  it('is zero for clips that merely touch', () => {
    const a = clip({ id: 'a', start: 0, duration: 100 })
    const b = clip({ id: 'b', start: 100, duration: 100 })
    expect(overlapFrames(a, b)).toBe(0)
  })

  it('counts the shared frames', () => {
    const a = clip({ id: 'a', start: 0, duration: 100 })
    const b = clip({ id: 'b', start: 70, duration: 100 })
    expect(overlapFrames(a, b)).toBe(30)
  })

  it('handles one clip swallowing another', () => {
    const a = clip({ id: 'a', start: 0, duration: 200 })
    const b = clip({ id: 'b', start: 50, duration: 40 })
    expect(overlapFrames(a, b)).toBe(40)
  })
})

describe('fadesWithNeighbours', () => {
  it('turns an overlap into a fade on both sides of it', () => {
    /*
     * The fact the whole feature rests on. Before this, an overlap meant both
     * clips playing at once at full — rendered and measured, the overlap came
     * back 3.0 dB hot, which is two uncorrelated signals summing, because that
     * is what it was.
     */
    const a = clip({ id: 'a', start: 0, duration: 120 })
    const b = clip({ id: 'b', start: 100, duration: 120 })
    expect(fadesWithNeighbours(a, null, b).fadeOut).toBe(20)
    expect(fadesWithNeighbours(b, a, null).fadeIn).toBe(20)
  })

  it('leaves a clip with no neighbours alone', () => {
    const a = clip({ id: 'a' })
    expect(fadesWithNeighbours(a, null, null)).toEqual({
      duration: a.duration, fadeIn: undefined, fadeOut: undefined
    })
  })

  it('never overrides a fade someone drew', () => {
    /*
     * Someone who has drawn a fade on this edge has said what they want. A
     * derived one replacing it would undo work with no visible cause — and
     * `0` in particular has to survive, since "I deliberately want no fade
     * here despite the overlap" is a real answer and the falsy one.
     */
    const a = clip({ id: 'a', start: 0, duration: 120, fadeOut: 5 })
    const b = clip({ id: 'b', start: 100, duration: 120, fadeIn: 0 })
    expect(fadesWithNeighbours(a, null, b).fadeOut).toBe(5)
    expect(fadesWithNeighbours(b, a, null).fadeIn).toBe(0)
  })

  it('ignores clips that only touch', () => {
    const a = clip({ id: 'a', start: 0, duration: 100 })
    const b = clip({ id: 'b', start: 100, duration: 100 })
    expect(fadesWithNeighbours(a, null, b).fadeOut).toBeUndefined()
    expect(fadesWithNeighbours(b, a, null).fadeIn).toBeUndefined()
  })
})

describe('crossfadeAt', () => {
  const two = (): Clip[] => [
    clip({ id: 'one', start: 0, duration: FPS * 4 }),
    clip({ id: 'two', start: FPS * 4, duration: FPS * 4 })
  ]

  it('slides the incoming clip back and fades both edges', () => {
    const after = crossfadeAt(project(two()), 'two', FPS)
    const one = after.clips.find((c) => c.id === 'one')!
    const twoClip = after.clips.find((c) => c.id === 'two')!
    expect(twoClip.start).toBe(FPS * 3)
    expect(overlapFrames(one, twoClip)).toBe(FPS)
    expect(one.fadeOut).toBe(FPS)
    expect(twoClip.fadeIn).toBe(FPS)
  })

  it('moves the incoming clip, never lengthens the outgoing one', () => {
    /*
     * Lengthening the outgoing clip — what `anchorTransition` does for video —
     * needs source material past its out point. A music clip trimmed to the
     * end of its file has none, so the "extra" would be silence and the
     * outgoing half would cross-fade into nothing. Moving the incoming clip
     * back uses frames both clips already have.
     */
    const after = crossfadeAt(project(two()), 'two', FPS)
    expect(after.clips.find((c) => c.id === 'one')!.duration).toBe(FPS * 4)
    expect(after.clips.find((c) => c.id === 'one')!.start).toBe(0)
  })

  it('closes the rest of the track up behind it', () => {
    const three = [...two(), clip({ id: 'three', start: FPS * 8, duration: FPS * 4 })]
    const after = crossfadeAt(project(three), 'two', FPS)
    expect(after.clips.find((c) => c.id === 'three')!.start).toBe(FPS * 7)
  })

  it('leaves other tracks exactly where they were', () => {
    const clips = [...two(), clip({ id: 'other', trackId: 'a2', start: FPS * 6, duration: FPS * 2 })]
    const after = crossfadeAt(project(clips), 'two', FPS)
    expect(after.clips.find((c) => c.id === 'other')!.start).toBe(FPS * 6)
  })

  it('changes an existing crossfade by the difference rather than stacking', () => {
    const once = crossfadeAt(project(two()), 'two', FPS)
    const twice = crossfadeAt(once, 'two', FPS * 2)
    const one = twice.clips.find((c) => c.id === 'one')!
    const second = twice.clips.find((c) => c.id === 'two')!
    expect(overlapFrames(one, second)).toBe(FPS * 2)
    expect(second.start).toBe(FPS * 2)
    expect(second.fadeIn).toBe(FPS * 2)
  })

  it('cannot swallow either clip whole', () => {
    const clips = [
      clip({ id: 'one', start: 0, duration: 20 }),
      clip({ id: 'two', start: 20, duration: FPS * 4 })
    ]
    const after = crossfadeAt(project(clips), 'two', FPS * 10)
    const one = after.clips.find((c) => c.id === 'one')!
    const second = after.clips.find((c) => c.id === 'two')!
    // At most one frame short of the shorter clip, so neither vanishes.
    expect(overlapFrames(one, second)).toBe(19)
    expect(second.start).toBeGreaterThan(0)
  })

  it('does nothing to the first clip on a track', () => {
    const before = project([clip({ id: 'only', start: 0, duration: FPS * 4 })])
    expect(crossfadeAt(before, 'only', FPS)).toBe(before)
    expect(maxCrossfadeFrames(before, before.clips.find((c) => c.id === 'only')!)).toBe(0)
  })
})

describe('a crossfade in the render plan', () => {
  it('emits an equal-power pair across the overlap', () => {
    const after = crossfadeAt(
      project([
        clip({ id: 'one', start: 0, duration: FPS * 4 }),
        clip({ id: 'two', start: FPS * 4, duration: FPS * 4 })
      ]),
      'two',
      FPS
    )
    const graph = buildRenderPlan({ project: after, outputPath: '/tmp/x.mp4' }).args.join(' ')
    // One second out of the first, one second into the second, both qsin.
    expect(graph).toContain('afade=t=out:st=3.0000:d=1.0000:curve=qsin')
    expect(graph).toContain('afade=t=in:st=0:d=1.0000:curve=qsin')
  })

  it('crossfades an overlap nobody asked for — a video dissolve', () => {
    /*
     * `anchorTransition` genuinely overlaps its two clips, so for the length
     * of every dissolve both soundtracks played at once. Nothing wrote a fade
     * because nothing knew to; deriving it from the overlap fixes every way an
     * overlap can arise, including the ones not written yet.
     */
    const overlapping = project([
      clip({ id: 'one', trackId: 'v1', start: 0, duration: FPS * 4 }),
      clip({ id: 'two', trackId: 'v1', start: FPS * 3, duration: FPS * 4 })
    ])
    // Both on a video track, both carrying sound.
    const withSound: Project = {
      ...overlapping,
      assets: overlapping.assets.map((a) => (a.id === 'p' ? { ...a, hasAudio: true } : a)),
      clips: overlapping.clips.filter((c) => c.id !== 'pic')
    }
    const graph = buildRenderPlan({ project: withSound, outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).toContain('afade=t=out:st=3.0000:d=1.0000:curve=qsin')
    expect(graph).toContain('afade=t=in:st=0:d=1.0000:curve=qsin')
  })

  it('reads neighbours on the clip’s OWN track, not across tracks', () => {
    /*
     * Two tracks playing over each other is the whole point of having two.
     * Treating a cross-track overlap as an edit point would fade out the music
     * every time a sound effect landed on top of it.
     */
    const graph = buildRenderPlan({
      project: project([
        clip({ id: 'music', trackId: 'a1', start: 0, duration: FPS * 8 }),
        clip({ id: 'sfx', trackId: 'a2', start: FPS * 2, duration: FPS })
      ]),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).not.toContain('afade')
  })
})
