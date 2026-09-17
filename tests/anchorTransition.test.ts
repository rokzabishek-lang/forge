import { describe, it, expect } from 'vitest'
import {
  addTransition,
  anchorTransition,
  clipEnd,
  emptyProject,
  type Clip,
  type Project
} from '@shared/timeline'

/*
 * A transition that moves nothing.
 *
 * `addTransition` closes the timeline up around the overlap, which is right for
 * a hand-cut edit and wrong for anything cut to music: every shot in a reel has
 * a start that was computed against a beat, and rippling drags all of them off
 * it cumulatively. Measured in the harness before this existed — a reel whose
 * shots were planned for frames 0, 61, 121, 180, 240, 301, 360, 420 came out at
 * 0, 61, 121, 181, 234, 295, 347, 400. The last shot was twenty frames adrift,
 * and two of the displaced clips had no transition of their own at all.
 */

function shots(starts: number[], duration = 60): Clip[] {
  return starts.map((start, i) => ({
    id: `c${i}`,
    assetId: 'a1',
    trackId: 'v1',
    start,
    duration,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }))
}

function project(clips: Clip[]): Project {
  return { ...emptyProject(), clips }
}

const starts = (p: Project): number[] =>
  p.clips.filter((c) => c.trackId === 'v1').sort((a, b) => a.start - b.start).map((c) => c.start)

describe('anchorTransition', () => {
  it('leaves every start exactly where the music put it', () => {
    let p = project(shots([0, 60, 120, 180, 240]))
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      p = anchorTransition(p, id, 'dissolve', 7)
    }
    expect(starts(p)).toEqual([0, 60, 120, 180, 240])
  })

  it('and the one it replaces does not — which is the whole reason it exists', () => {
    let p = project(shots([0, 60, 120, 180, 240]))
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      p = addTransition(p, id, 'dissolve', 7)
    }
    const drifted = starts(p)
    expect(drifted).not.toEqual([0, 60, 120, 180, 240])
    // Cumulative, and worse the further in you go.
    expect(drifted[4]).toBeLessThan(240 - 7)
  })

  it('takes the overlap out of the outgoing clip’s tail', () => {
    const p = anchorTransition(project(shots([0, 60])), 'c1', 'dissolve', 7)
    const first = p.clips.find((c) => c.id === 'c0')!
    const second = p.clips.find((c) => c.id === 'c1')!
    expect(second.start).toBe(60)
    expect(first.duration).toBe(67)
    // They genuinely overlap, by exactly the transition's length.
    expect(clipEnd(first) - second.start).toBe(7)
  })

  it('overlaps the same frames of the incoming clip as rippling would', () => {
    /*
     * What the renderer actually reads is "the incoming clip's first N frames
     * are over the outgoing one". Rippling and anchoring produce the same
     * relationship, which is why nothing downstream needed changing.
     */
    const rippled = addTransition(project(shots([0, 60])), 'c1', 'dissolve', 7)
    const anchored = anchorTransition(project(shots([0, 60])), 'c1', 'dissolve', 7)
    for (const p of [rippled, anchored]) {
      const a = p.clips.find((c) => c.id === 'c0')!
      const b = p.clips.find((c) => c.id === 'c1')!
      expect(clipEnd(a) - b.start).toBe(7)
      expect(b.transitionIn).toEqual({ id: 'dissolve', durationFrames: 7 })
    }
  })

  it('does not stack when the same transition is set twice', () => {
    let p = anchorTransition(project(shots([0, 60])), 'c1', 'dissolve', 7)
    p = anchorTransition(p, 'c1', 'dissolve', 7)
    expect(p.clips.find((c) => c.id === 'c0')!.duration).toBe(67)
  })

  it('grows by the difference when the length changes', () => {
    let p = anchorTransition(project(shots([0, 60])), 'c1', 'dissolve', 7)
    p = anchorTransition(p, 'c1', 'dissolve', 12)
    expect(p.clips.find((c) => c.id === 'c0')!.duration).toBe(72)
    expect(p.clips.find((c) => c.id === 'c1')!.start).toBe(60)
  })

  it('never asks for more overlap than the shorter clip has', () => {
    const p = anchorTransition(project(shots([0, 10], 10)), 'c1', 'dissolve', 500)
    expect(p.clips.find((c) => c.id === 'c1')!.transitionIn!.durationFrames).toBe(9)
  })

  it('gives a layered clip its transition without lengthening anything', () => {
    // Nothing before it on its own track: it blends against the layer below,
    // which runs its own length regardless.
    const layered = shots([0, 60])
    layered[1].trackId = 'v2'
    const p = anchorTransition(project(layered), 'c1', 'dissolve', 7)
    expect(p.clips.find((c) => c.id === 'c0')!.duration).toBe(60)
    expect(p.clips.find((c) => c.id === 'c1')!.start).toBe(60)
    expect(p.clips.find((c) => c.id === 'c1')!.transitionIn?.durationFrames).toBe(7)
  })

  it('leaves a clip that is not there alone', () => {
    const p = project(shots([0, 60]))
    expect(anchorTransition(p, 'nope', 'dissolve', 7)).toBe(p)
  })
})
