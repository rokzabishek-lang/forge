import { describe, expect, it } from 'vitest'
import { emptyProject, freezeFrame, sourceFrameFor, splitClip, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { clipRateAt, rampRate, sourceFramesFor } from '@shared/render/speed'

/**
 * A freeze (docs/PLAN.md §5.5): three clips where there was one — the shot up
 * to the frame, a hold on it, the shot resuming with the NEXT frame — and a
 * ramp, split, is two ramps that meet at the rate under the cut.
 */

const video: MediaAsset = { id: 'v', path: '/v.mp4', name: 'v', kind: 'video', durationFrames: 300, width: 64, height: 64, fps: 30, hasVideo: true, hasAudio: true, size: 1 }
const photo: MediaAsset = { ...video, id: 'p', kind: 'image', hasAudio: false }
const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 60, inPoint: 10, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
})
const project = (clips: Clip[]): Project => ({ ...emptyProject(), assets: [video, photo], clips })

describe('freezeFrame', () => {
  it('holds the frame the playhead shows, then resumes on the next one — and what follows moves by the time added', () => {
    const p = project([clip(), clip({ id: 'after', start: 60, duration: 30 })])
    const out = freezeFrame(p, 'c', 30, 15)!
    const [a, hold, resume] = out.clips.filter((c) => c.id.startsWith('c'))
    expect([a.start, a.duration, a.inPoint]).toEqual([0, 30, 10])
    expect([hold.start, hold.duration, hold.inPoint, hold.hold, hold.volume]).toEqual([30, 15, 40, true, 0])
    expect([resume.start, resume.inPoint, resume.duration]).toEqual([45, 41, 29])
    // The frames on screen: 10..39, then 40 held, then 41 on.
    expect(sourceFrameFor(a, 29)).toBe(39)
    for (const f of [30, 37, 44]) expect(sourceFrameFor(hold, f)).toBe(40)
    expect(sourceFrameFor(resume, 45)).toBe(41)
    // One frame decoded, however long it is held.
    expect(sourceFramesFor(hold)).toBe(1)
    expect(clipRateAt(hold, 35)).toBe(0)
    expect(out.clips.find((c) => c.id === 'after')!.start).toBe(60 + 14)
  })

  it('freezes on the first frame without a head, and on the last without a tail', () => {
    const first = freezeFrame(project([clip()]), 'c', 0, 10)!
    expect(first.clips.map((c) => c.id)).toEqual(['c-hold', 'c-resume'])
    const last = freezeFrame(project([clip()]), 'c', 59, 10)!
    expect(last.clips.map((c) => c.id)).toEqual(['c', 'c-hold'])
  })

  it('refuses a still, a ramp, a frame outside the clip, and no hold at all', () => {
    expect(freezeFrame(project([clip({ assetId: 'p' })]), 'c', 30, 15)).toBeNull()
    expect(freezeFrame(project([clip({ ramp: { from: 1, to: 0.5 } })]), 'c', 30, 15)).toBeNull()
    expect(freezeFrame(project([clip()]), 'c', 60, 15)).toBeNull()
    expect(freezeFrame(project([clip()]), 'c', 30, 0)).toBeNull()
  })
})

describe('splitting a ramp', () => {
  it('gives each half its own part of the curve, meeting at the rate under the cut, and the footage adds up', () => {
    const ramped = clip({ duration: 110, inPoint: 0, ramp: { from: 1, to: 0.25 } })
    const [left, right] = splitClip(ramped, 40)!
    const under = clipRateAt(ramped, 40)
    expect(left.ramp).toEqual({ from: 1, to: under })
    expect(right.ramp).toEqual({ from: under, to: 0.25 })
    // Each half plays its own footage in its own time: together, the whole clip's.
    const leftSource = left.duration * rampRate(left.ramp!.from, left.ramp!.to)
    const rightSource = right.duration * rampRate(right.ramp!.from, right.ramp!.to)
    expect(leftSource + rightSource).toBeCloseTo(ramped.duration * rampRate(1, 0.25), 0)
    // The right half starts on the frame the whole clip showed there.
    expect(right.inPoint).toBe(sourceFrameFor(ramped, 40))
    // And later frames stay within a frame of where the unsplit ramp was (the halves round separately).
    expect(Math.abs(sourceFrameFor(right, 80) - sourceFrameFor(ramped, 80))).toBeLessThanOrEqual(1)
  })
})
