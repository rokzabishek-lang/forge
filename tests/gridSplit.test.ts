import { describe, it, expect } from 'vitest'
import { DEFAULT_GRID, type GridSpec } from '@shared/render/grid'
import { GRID_RULE, gridClips, planGridSplit } from '@shared/automation/grid'
import type { MusicAnalysis } from '@shared/automation/cutPlan'

const FPS = 30
const TALL = { width: 1080, height: 1920 }
const PHOTO = { width: 4000, height: 3000 }

function spec(over: Partial<GridSpec> = {}): GridSpec {
  return { ...DEFAULT_GRID, ...over }
}

/** A steady 120 BPM: a beat every 500ms, a downbeat every four. */
function music(beatCount = 32, bpm = 120): MusicAnalysis {
  const period = 60_000 / bpm
  const beats = Array.from({ length: beatCount }, (_, i) => Math.round(i * period))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 2),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: beatCount * period
  }
}

describe('planGridSplit', () => {
  it('lands one piece on every beat', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 2 }),
      order: 'rows',
      analysis: music()
    })
    expect(pieces).toHaveLength(4)
    // 120 BPM is half a second, which is fifteen frames at 30fps.
    expect(pieces.map((p) => p.startFrame)).toEqual([0, 15, 30, 45])
  })

  it('every piece runs to the same end, so the picture stays assembled', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 3 }),
      order: 'rows',
      analysis: music(),
      holdSeconds: 2
    })
    const ends = pieces.map((p) => p.startFrame + p.durationFrames)
    expect(new Set(ends).size).toBe(1)
    // Last arrival plus the hold.
    expect(ends[0]).toBe(pieces[pieces.length - 1].startFrame + 60)
  })

  it('lands on the beats themselves, not on an evenly spaced imitation', () => {
    /*
     * The bug this guards: subtracting the first beat so the grid "starts at
     * zero". The caller then adds the music clip's position, which the analysis
     * is ALREADY measured from — so every piece slid earlier by however far the
     * first downbeat sits into the track. The spacing stayed perfect, the grid
     * looked fine, and nothing landed on a beat.
     *
     * A track whose first downbeat is 900ms in, which is the ordinary case for
     * anything with an intro.
     */
    const offset = music()
    offset.beats = offset.beats.map((ms) => ms + 900)
    offset.downbeats = offset.downbeats.map((ms) => ms + 900)

    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 2 }),
      order: 'rows',
      analysis: offset
    })
    // 900ms is 27 frames at 30fps, then a beat every 15.
    expect(pieces.map((p) => p.startFrame)).toEqual([27, 42, 57, 72])
    for (const piece of pieces) {
      const ms = (piece.startFrame / FPS) * 1000
      expect(offset.beats.some((beat) => Math.abs(beat - ms) < 20)).toBe(true)
    }
  })

  it('keeps landing on beats past the end of the track', () => {
    const offset = music(4)
    offset.beats = offset.beats.map((ms) => ms + 900)
    offset.downbeats = [offset.beats[0]]
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 3 }),
      order: 'rows',
      analysis: offset
    })
    // The four real beats, then the same 500ms gap carried on from them.
    expect(pieces.map((p) => p.startFrame)).toEqual([27, 42, 57, 72, 87, 102])
  })

  it('lands twice a beat, which is where the reference templates actually sit', () => {
    /*
     * Measured off a real template at 112 BPM: 73% of its visual changes fall
     * within one video frame of a SIXTEENTH-note grid, and its grid pieces
     * arrive on eighths. A whole beat — the obvious setting — plays at half
     * that, and the difference is the whole feel of the thing.
     */
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 2 }),
      order: 'rows',
      analysis: music(),
      beatsPerCell: 0.5
    })
    // 120 BPM: a beat is 15 frames, so an eighth is 7.5 and rounds alternately.
    expect(pieces.map((p) => p.startFrame)).toEqual([0, 8, 15, 23])
  })

  it('goes to four a beat without inventing beats the analysis never found', () => {
    const swung = music(8)
    // A performance that drags: the subdivisions have to drag with it.
    swung.beats = [0, 500, 1100, 1600, 2100, 2600, 3100, 3600]
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 2 }),
      order: 'rows',
      analysis: swung,
      beatsPerCell: 0.25
    })
    // Quarters of the FIRST beat's span (500ms), then of the second (600ms).
    expect(pieces.map((p) => p.startFrame)).toEqual([0, 4, 8, 11])
  })

  it('takes every other beat when asked', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 2 }),
      order: 'rows',
      analysis: music(),
      beatsPerCell: 2
    })
    expect(pieces.map((p) => p.startFrame)).toEqual([0, 30, 60, 90])
  })

  it('still places every piece when the song runs out of beats', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 4, cols: 5 }),
      order: 'rows',
      // Only six beats for twenty pieces.
      analysis: music(6)
    })
    expect(pieces).toHaveLength(20)
    const starts = pieces.map((p) => p.startFrame)
    // Strictly increasing: nothing piles onto the final beat.
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1])
  })

  it('works with no music at all, on an even cadence', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 1, cols: 4 }),
      order: 'rows',
      analysis: null,
      cadenceSeconds: 0.2
    })
    expect(pieces.map((p) => p.startFrame)).toEqual([0, 6, 12, 18])
  })

  it('sits where it is put on the timeline', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 1, cols: 2 }),
      order: 'rows',
      analysis: music(),
      startFrame: 300,
      holdSeconds: 1
    })
    expect(pieces[0].startFrame).toBe(300)
    expect(pieces[1].startFrame).toBe(315)
    expect(pieces[0].startFrame + pieces[0].durationFrames).toBe(315 + 30)
  })

  it('"all at once" really is at once, and no longer than it needs', () => {
    const pieces = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 3, cols: 3 }),
      order: 'together',
      analysis: music(),
      holdSeconds: 1
    })
    expect(pieces).toHaveLength(9)
    expect(new Set(pieces.map((p) => p.startFrame)).size).toBe(1)
    // Nine beats of nothing happening is not what "at once" means: the grid
    // runs for the hold, not for the span the staggered version would have.
    expect(pieces[0].durationFrames).toBe(30)
  })

  it('reveals in the order it was asked for', () => {
    const down = planGridSplit({
      fps: FPS,
      source: PHOTO,
      canvas: TALL,
      spec: spec({ rows: 2, cols: 3 }),
      order: 'columns',
      analysis: music()
    })
    // Column order: (0,0) (1,0) (0,1) (1,1) …
    expect(down.map((p) => p.cell.index)).toEqual([0, 3, 1, 4, 2, 5])
    // and the earliest arrival is still the first in the sequence.
    expect(down[0].startFrame).toBeLessThan(down[1].startFrame)
  })
})

describe('gridClips', () => {
  const pieces = planGridSplit({
    fps: FPS,
    source: PHOTO,
    canvas: TALL,
    spec: spec({ rows: 2, cols: 2, shape: 'circle' }),
    order: 'rows',
    analysis: music()
  })

  it('writes ordinary clips, labelled with why they are there', () => {
    const clips = gridClips(pieces, 'v1', 'photo', FPS)
    expect(clips).toHaveLength(4)
    for (const clip of clips) {
      expect(clip.generatedBy?.rule).toBe(GRID_RULE)
      expect(clip.generatedBy?.reason).toMatch(/piece \d/)
      expect(clip.assetId).toBe('photo')
      expect(clip.trackId).toBe('v1')
      expect(clip.crop).toBeDefined()
      expect(clip.mask?.mode).toBe('reveal')
    }
    expect(new Set(clips.map((c) => c.id)).size).toBe(4)
  })

  it('leaves a snap-in piece with no animation to pay for', () => {
    const clips = gridClips(pieces, 'v1', 'photo', FPS, 'cut')
    expect(clips.every((c) => c.keyframes === undefined)).toBe(true)
  })

  it('punches a pop-in down from too big rather than up from too small', () => {
    const clips = gridClips(pieces, 'v1', 'photo', FPS, 'pop')
    const zoom = clips[0].keyframes?.zoom
    expect(zoom).toBeDefined()
    expect(zoom![0].value).toBeGreaterThan(1)
    expect(zoom![zoom!.length - 1].value).toBe(1)
    // Short enough to be over before the next beat at any usable tempo.
    expect(zoom![zoom!.length - 1].frame).toBeLessThanOrEqual(Math.round(FPS * 0.2))
  })

  it('fades without moving', () => {
    const clips = gridClips(pieces, 'v1', 'photo', FPS, 'fade')
    expect(clips[0].keyframes?.opacity?.[0].value).toBe(0)
    expect(clips[0].keyframes?.zoom).toBeUndefined()
  })
})
