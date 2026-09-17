import { describe, it, expect } from 'vitest'
import { planReel, reelClips, REEL_RULE, DEFAULT_MOTION_AMOUNT } from '@shared/automation/reel'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject, clipEnd, type MediaAsset } from '@shared/timeline'

function images(count: number): MediaAsset[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `img${i}`, path: `/p/${i}.jpg`, name: `${i}.jpg`, kind: 'image' as const,
    durationFrames: 90, width: 1920, height: 1080, fps: null,
    hasVideo: true, hasAudio: false, size: 0
  }))
}

function music(bpm = 120, seconds = 30, over: Partial<MusicAnalysis> = {}): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return {
    bpm, beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 1),
    drops: [], buildups: [], sections: [],
    durationMs: seconds * 1000,
    ...over
  }
}

const options = { fps: 30 }

describe('planReel', () => {
  it('produces one shot per planned cut', () => {
    const shots = planReel(images(5), music(), options)
    expect(shots.length).toBeGreaterThan(5)
  })

  it('cycles images when there are fewer photos than shots', () => {
    const shots = planReel(images(3), music(), options)
    // A dozen photos over 30s is the normal case; stretching each one would
    // leave stills on screen far too long.
    expect(shots[0].assetId).toBe('img0')
    expect(shots[3].assetId).toBe('img0')
    expect(new Set(shots.map((s) => s.assetId)).size).toBe(3)
  })

  it('never repeats a camera move on consecutive shots', () => {
    const shots = planReel(images(4), music(), options)
    for (let i = 1; i < shots.length; i++) {
      const previous = shots[i - 1].motion
      const current = shots[i].motion
      if (previous?.kind !== 'kenburns' || current?.kind !== 'kenburns') continue
      expect(current.direction).not.toBe(previous.direction)
    }
  })

  it('draws on a wide repertoire, not two alternating zooms', () => {
    // Alternating push/pull is itself a pattern the eye catches within four
    // shots — the whole reason this is not just `i % 2`.
    const shots = planReel(images(4), music(120, 60), options)
    const moves = new Set(
      shots.map((s) => (s.motion?.kind === 'kenburns' ? s.motion.direction : 'shake'))
    )
    expect(moves.size).toBeGreaterThanOrEqual(4)
  })

  it('holds the frame and shakes on a drop', () => {
    const shots = planReel(
      images(4),
      music(120, 30, { drops: [{ ms: 15_000, score: 0.9 }] }),
      options
    )
    const drop = shots.find((s) => s.reason === 'on the drop')
    expect(drop?.motion?.kind).toBe('shake')
  })

  it('scales the move with the energy of the moment', () => {
    const loud = planReel(images(4), music(120, 30, { tiers: [] }), options)
    expect(loud.length).toBeGreaterThan(0)
    const quiet = planReel(
      images(4),
      { ...music(120, 30), tiers: music(120, 30).beats.map(() => 0) },
      options
    )
    const amountOf = (s: (typeof loud)[number]): number => s.motion?.amount ?? 0
    expect(amountOf(quiet[0])).toBeLessThan(DEFAULT_MOTION_AMOUNT)
  })

  it('leaves no gaps — each shot runs to the next cut', () => {
    const shots = planReel(images(4), music(), options)
    for (let i = 1; i < shots.length; i++) {
      const previousEnd = shots[i - 1].startFrame + shots[i - 1].durationFrames
      expect(Math.abs(shots[i].startFrame - previousEnd)).toBeLessThanOrEqual(1)
    }
  })

  it('explains why each shot starts where it does', () => {
    const shots = planReel(images(4), music(120, 30, {
      drops: [{ ms: 15_000, score: 0.9 }]
    }), options)
    expect(shots.some((s) => s.reason === 'on the drop')).toBe(true)
    expect(shots.every((s) => s.reason.length > 0)).toBe(true)
  })

  it('returns nothing without photos or without beats', () => {
    expect(planReel([], music(), options)).toEqual([])
    expect(planReel(images(3), { ...music(), beats: [], downbeats: [] }, options)).toEqual([])
  })

  it('treats most cuts — stills are not footage', () => {
    // The ~90% hard-cut finding is about footage, where the subject's own
    // movement carries the cut. Two unrelated photographs have no such
    // continuity, and applying the footage rate left a reel looking like a
    // contact sheet.
    const shots = planReel(images(4), music(120, 60, {
      drops: [{ ms: 30_000, score: 0.9 }],
      sections: [15_000, 45_000]
    }), options)
    const withTransition = shots.filter((s) => s.transitionTier !== null).length
    expect(withTransition / shots.length).toBeGreaterThan(0.4)
  })

  it('spreads transitions across the whole reel, not just the loud part', () => {
    const shots = planReel(images(4), music(120, 60, {
      drops: [{ ms: 45_000, score: 0.9 }]
    }), options)
    const half = Math.floor(shots.length / 2)
    const early = shots.slice(0, half).filter((s) => s.transitionTier !== null).length
    expect(early).toBeGreaterThan(0)
  })

  it('honours an explicit rate of zero', () => {
    const shots = planReel(images(4), music(120, 30), { ...options, transitionRate: 0 })
    expect(shots.every((s) => s.transitionTier === null)).toBe(true)
  })
})

describe('reelClips', () => {
  const project = () => ({ ...emptyProject(), assets: images(3) })

  it('marks every clip with its rule, so clearing is exact', () => {
    const shots = planReel(images(3), music(), options)
    const clips = reelClips(project(), shots, 'v1')
    expect(clips.every((c) => c.generatedBy?.rule === REEL_RULE)).toBe(true)
  })

  it('never overlaps clips on the track', () => {
    const shots = planReel(images(3), music(), options)
    const clips = reelClips(project(), shots, 'v1')
    const sorted = [...clips].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(clipEnd(sorted[i - 1]))
    }
  })

  it('gives every clip a camera move by default', () => {
    const clips = reelClips(project(), planReel(images(3), music(), options), 'v1')
    expect(clips.every((c) => c.motion !== undefined)).toBe(true)
  })

  it('omits motion entirely when the amount is zero', () => {
    const shots = planReel(images(3), music(), { ...options, motionAmount: 0 })
    const clips = reelClips(project(), shots, 'v1')
    expect(clips.every((c) => c.motion === undefined)).toBe(true)
  })

  it('places every clip on the requested track', () => {
    const clips = reelClips(project(), planReel(images(3), music(), options), 'v2')
    expect(clips.every((c) => c.trackId === 'v2')).toBe(true)
  })
})

describe('parallax in the reel', () => {
  it('uses depth only for photos that have a usable bake', () => {
    const shots = planReel(images(3), music(120, 30), {
      ...options,
      parallaxAssets: new Set(['img0', 'img2'])
    })
    const kinds = new Map<string, Set<string>>()
    for (const shot of shots) {
      if (!shot.motion || shot.motion.kind === 'shake') continue
      const set = kinds.get(shot.assetId) ?? new Set()
      set.add(shot.motion.kind)
      kinds.set(shot.assetId, set)
    }
    // A photo that would not separate keeps the flat move, and the reel is
    // still coherent — mixing the two is the designed behaviour, not a bug.
    expect([...(kinds.get('img0') ?? [])]).toEqual(['parallax'])
    expect([...(kinds.get('img1') ?? [])]).toEqual(['kenburns'])
    expect([...(kinds.get('img2') ?? [])]).toEqual(['parallax'])
  })

  it('stays flat when nothing is baked', () => {
    const shots = planReel(images(3), music(120, 30), options)
    expect(shots.every((s) => s.motion?.kind !== 'parallax')).toBe(true)
  })

  it('moves a depth shot laterally, never on a dead-centre push', () => {
    /*
     * A centred push is the worst possible move to show parallax with: its
     * displacement is radial, so the planes separate by a few percent spread
     * evenly around the frame and it reads as a slightly odd zoom. That is
     * precisely what the first parallax build looked like on screen.
     */
    const shots = planReel(images(3), music(120, 60), {
      ...options,
      parallaxAssets: new Set(['img0', 'img1', 'img2'])
    })
    const moves = shots
      .map((s) => (s.motion?.kind === 'parallax' ? s.motion.direction : null))
      .filter((m): m is NonNullable<typeof m> => m !== null)

    expect(moves.length).toBeGreaterThan(0)
    expect(moves).not.toContain('in')
    expect(moves).not.toContain('out')
    // Mostly true pans — the unmistakable case.
    expect(moves.filter((m) => m.startsWith('pan')).length / moves.length).toBeGreaterThan(0.5)
  })

  it('still varies the move on depth shots', () => {
    const shots = planReel(images(3), music(120, 60), {
      ...options,
      parallaxAssets: new Set(['img0', 'img1', 'img2'])
    })
    const moves = shots.map((s) => (s.motion?.kind === 'parallax' ? s.motion.direction : 'shake'))
    expect(new Set(moves).size).toBeGreaterThanOrEqual(3)
  })

  it('asks for the same travel as a flat move', () => {
    const deep = planReel(images(1), music(120, 30), {
      ...options,
      parallaxAssets: new Set(['img0'])
    })
    const flat = planReel(images(1), music(120, 30), options)
    const first = (list: typeof deep): number =>
      list.find((s) => s.motion?.kind !== 'shake')?.motion?.amount ?? 0
    // planeAmount already caps the spread at what the baked fill band covers.
    // Scaling down here as well was what made the first parallax build look
    // like an uneven Ken Burns rather than depth.
    expect(first(deep)).toBeCloseTo(first(flat), 6)
  })

  it('says so in the reason, so the user can see why a shot looks different', () => {
    const shots = planReel(images(1), music(120, 30), {
      ...options,
      parallaxAssets: new Set(['img0'])
    })
    expect(shots.some((s) => s.reason.includes('depth'))).toBe(true)
  })
})

describe('coverage', () => {
  /*
   * A reel must fill the music it was built from.
   *
   * A rendered 36s export came back with its last 4.4 seconds blank: the music
   * kept playing over black. Whatever else the planner does, the shots have to
   * span the analysed window end to end.
   */
  it('covers the analysed window from start to finish', () => {
    for (const seconds of [10, 30, 36, 61]) {
      const analysis = music(120, seconds)
      const shots = planReel(images(4), analysis, options)
      const fps = options.fps
      const firstMs = (shots[0].startFrame / fps) * 1000
      const last = shots[shots.length - 1]
      const endMs = ((last.startFrame + last.durationFrames) / fps) * 1000

      expect(firstMs).toBeLessThan(600)
      expect(analysis.durationMs - endMs).toBeLessThan(600)
    }
  })

  it('starts at the very first frame', () => {
    const shots = planReel(images(4), music(120, 30), options)
    expect(shots[0].startFrame).toBe(0)
  })

  it('leaves no hole between consecutive shots', () => {
    const shots = planReel(images(4), music(120, 45, {
      drops: [{ ms: 20_000, score: 0.9 }], sections: [10_000, 30_000]
    }), options)
    for (let i = 1; i < shots.length; i++) {
      const previousEnd = shots[i - 1].startFrame + shots[i - 1].durationFrames
      expect(shots[i].startFrame).toBeLessThanOrEqual(previousEnd)
    }
  })
})

describe('shots tile the music exactly', () => {
  it('never overlaps, so nothing gets nudged off its beat', () => {
    /*
     * Lengths used to be measured from the millisecond gap between cuts while
     * positions came from the frames, and the two round independently — so a
     * shot could come out a frame too long, overlap the next one, and send
     * `findFreeSlot` off to nudge it a frame later. One frame per collision, on
     * a reel cut to a beat grid.
     */
    // 117 BPM: a beat is 512.8ms, which does not divide evenly into frames.
    const analysis = music(117, 40)
    const shots = planReel(images(6), analysis, { fps: 30, transitionRate: 0 })
    expect(shots.length).toBeGreaterThan(4)
    for (let i = 1; i < shots.length; i++) {
      const previousEnd = shots[i - 1].startFrame + shots[i - 1].durationFrames
      expect(shots[i].startFrame).toBe(previousEnd)
    }
  })
})
