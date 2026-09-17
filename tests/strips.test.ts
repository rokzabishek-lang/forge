import { describe, it, expect } from 'vitest'
import { diagonalBand, stripCell, type StripLayout } from '@shared/render/strips'
import {
  DEFAULT_BEATS_PER_HIT,
  STRIP_LOOKS,
  STRIP_RULE,
  planStrips,
  stripClips,
  type StripPlanOptions
} from '@shared/automation/strips'
import type { MusicAnalysis } from '@shared/automation/cutPlan'

const TALL = { width: 1080, height: 1920 }
const PHOTO = { width: 4000, height: 3000 }
const FPS = 30

function music(beatCount = 64, bpm = 120): MusicAnalysis {
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

function options(over: Partial<StripPlanOptions> = {}): StripPlanOptions {
  return {
    fps: FPS,
    source: PHOTO,
    canvas: TALL,
    layout: 'vertical',
    count: 5,
    analysis: music(),
    ...over
  }
}

/** The cell's box in canvas pixels, the way clipBox works it out. */
function boxOf(cell: NonNullable<ReturnType<typeof stripCell>>): {
  x0: number
  y0: number
  x1: number
  y1: number
} {
  const w = cell.transform.scale * TALL.width
  const h = (cell.transform.scaleY ?? cell.transform.scale) * TALL.height
  const x0 = (TALL.width - w) / 2 + (cell.transform.x * TALL.width) / 2
  const y0 = (TALL.height - h) / 2 + (cell.transform.y * TALL.height) / 2
  return { x0, y0, x1: x0 + w, y1: y0 + h }
}

describe('stripCell', () => {
  it('cuts columns that span the full height and tile the width', () => {
    const boxes = [0, 1, 2, 3, 4].map((i) => boxOf(stripCell('vertical', 5, i, PHOTO, TALL)!))
    for (const box of boxes) {
      expect(box.y0).toBeCloseTo(0, 6)
      expect(box.y1).toBeCloseTo(TALL.height, 6)
    }
    expect(Math.min(...boxes.map((b) => b.x0))).toBeCloseTo(0, 6)
    expect(Math.max(...boxes.map((b) => b.x1))).toBeCloseTo(TALL.width, 6)
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].x0).toBeCloseTo(boxes[i - 1].x1, 6)
    }
  })

  it('cuts bands the other way round', () => {
    const boxes = [0, 1, 2].map((i) => boxOf(stripCell('horizontal', 3, i, PHOTO, TALL)!))
    for (const box of boxes) {
      expect(box.x0).toBeCloseTo(0, 6)
      expect(box.x1).toBeCloseTo(TALL.width, 6)
    }
    expect(boxes[1].y0).toBeCloseTo(boxes[0].y1, 6)
  })

  it('costs nothing per frame for a column or a band', () => {
    for (const layout of ['vertical', 'horizontal'] as StripLayout[]) {
      expect(stripCell(layout, 4, 1, PHOTO, TALL)!.mask).toBeUndefined()
    }
  })

  it('takes the whole frame for a diagonal, because the band crosses it', () => {
    const cell = stripCell('diagonal', 5, 2, PHOTO, TALL)!
    expect(cell.transform.scale).toBe(1)
    expect(cell.mask?.shape.kind).toBe('rectangle')
    expect(cell.mask?.shape.rotation).toBeGreaterThan(0)
  })

  it('wraps a slot rather than returning nothing for it', () => {
    expect(stripCell('vertical', 4, 7, PHOTO, TALL)!.col).toBe(3)
    expect(stripCell('vertical', 4, -1, PHOTO, TALL)!.col).toBe(3)
  })
})

describe('diagonalBand', () => {
  /** Where the band's centre line crosses, in canvas pixels, along its normal. */
  function offsetOf(slot: number, count: number, angle: number): number {
    const mask = diagonalBand(slot, count, angle, TALL)
    const radians = (angle * Math.PI) / 180
    const dx = (mask.shape.x - 0.5) * TALL.width
    const dy = (mask.shape.y - 0.5) * TALL.height
    // Undo the placement: offset p was written as (-p sin, p cos).
    return -Math.sin(radians) * dx + Math.cos(radians) * dy
  }

  it('spaces the bands evenly across the frame', () => {
    const offsets = [0, 1, 2, 3].map((i) => offsetOf(i, 4, 28))
    const gaps = [1, 2, 3].map((i) => offsets[i] - offsets[i - 1])
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 4)
    // Centred on the frame: the middle of the set sits at zero.
    expect((offsets[0] + offsets[3]) / 2).toBeCloseTo(0, 4)
  })

  it('covers the frame with no band left over', () => {
    const angle = 28
    const radians = (angle * Math.PI) / 180
    const reach =
      Math.abs(TALL.width * Math.sin(radians)) + Math.abs(TALL.height * Math.cos(radians))
    const thickness = reach / 6
    const first = offsetOf(0, 6, angle)
    const last = offsetOf(5, 6, angle)
    expect(first - thickness / 2).toBeCloseTo(-reach / 2, 3)
    expect(last + thickness / 2).toBeCloseTo(reach / 2, 3)
  })

  it('is long enough that its ends are never in frame', () => {
    const mask = diagonalBand(1, 4, 45, TALL)
    expect(mask.shape.width).toBeGreaterThan(1)
  })

  it('moves sideways, not along itself', () => {
    // A slid band must change BOTH coordinates at an angle; changing only x
    // would slide it along its own length and look like nothing happened.
    const a = diagonalBand(0, 4, 28, TALL).shape
    const b = diagonalBand(3, 4, 28, TALL).shape
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(0.001)
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(0.001)
  })
})

describe('planStrips', () => {
  it('hits four times a beat by default, on the grid', () => {
    expect(DEFAULT_BEATS_PER_HIT).toBe(0.25)
    const flashes = planStrips(options({ durationFrames: 120 }))
    expect(flashes.length).toBeGreaterThan(8)
    // 120 BPM: a beat is 15 frames, a sixteenth is 3.75.
    for (const flash of flashes) {
      const sixteenth = flash.startFrame / 3.75
      expect(Math.abs(sixteenth - Math.round(sixteenth))).toBeLessThan(0.34)
    }
  })

  it('leaves gaps rather than strobing on every subdivision', () => {
    const flashes = planStrips(options({ durationFrames: 300, perHit: 1, burstRate: 0 }))
    const moments = [...new Set(flashes.map((f) => f.startFrame))].sort((a, b) => a - b)
    const gaps = moments.slice(1).map((m, i) => m - moments[i])
    const single = gaps.filter((g) => g <= 4).length
    expect(single).toBeLessThan(gaps.length)
    expect(moments.length).toBeGreaterThan(4)
  })

  it('each flash lasts exactly one subdivision', () => {
    const flashes = planStrips(options({ durationFrames: 200 }))
    for (const flash of flashes) expect(flash.durationFrames).toBe(4)
  })

  it('bursts three on consecutive subdivisions, as the reference does', () => {
    const flashes = planStrips(options({ durationFrames: 600, perHit: 1, burstRate: 1 }))
    const bursts = flashes.filter((f) => f.reason.startsWith('burst'))
    expect(bursts.length).toBeGreaterThan(3)
    const thirds = flashes.filter((f) => f.reason === 'burst 3 of 3')
    expect(thirds.length).toBeGreaterThan(0)
  })

  it('lights more than one strip at a time when asked', () => {
    const flashes = planStrips(options({ durationFrames: 200, perHit: 3, burstRate: 0 }))
    const first = flashes[0].startFrame
    expect(flashes.filter((f) => f.startFrame === first)).toHaveLength(3)
  })

  it('works with no music, on an even cadence', () => {
    const flashes = planStrips(
      options({ analysis: null, durationFrames: 90, cadenceSeconds: 0.2, burstRate: 0 })
    )
    expect(flashes.length).toBeGreaterThan(2)
    expect(flashes[0].durationFrames).toBe(6)
  })

  it('does not reshuffle between builds', () => {
    const a = planStrips(options({ durationFrames: 300 }))
    const b = planStrips(options({ durationFrames: 300 }))
    expect(a).toEqual(b)
  })

  it('sits where it is put on the timeline', () => {
    const flashes = planStrips(options({ durationFrames: 120, startFrame: 250 }))
    expect(Math.min(...flashes.map((f) => f.startFrame))).toBeGreaterThanOrEqual(250)
  })
})

describe('stripClips', () => {
  it('writes silent, labelled overlay clips carrying the look', () => {
    const opts = options({ durationFrames: 200, look: 'flash' })
    const clips = stripClips(planStrips(opts), opts, 'v2', 'photo')
    expect(clips.length).toBeGreaterThan(4)
    for (const clip of clips) {
      expect(clip.generatedBy?.rule).toBe(STRIP_RULE)
      expect(clip.trackId).toBe('v2')
      // Silent: the shot underneath keeps its own sound.
      expect(clip.volume).toBe(0)
      expect(clip.color).toEqual(STRIP_LOOKS.flash)
      expect(clip.crop).toBeDefined()
    }
    expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length)
  })

  it('carries a mask only for the diagonal layout', () => {
    const flat = options({ durationFrames: 120, layout: 'vertical' })
    expect(stripClips(planStrips(flat), flat, 'v2', 'p').every((c) => !c.mask)).toBe(true)
    const angled = options({ durationFrames: 120, layout: 'diagonal' })
    expect(stripClips(planStrips(angled), angled, 'v2', 'p').every((c) => !!c.mask)).toBe(true)
  })

  it('crushes instead of lifting when asked', () => {
    const opts = options({ durationFrames: 120, look: 'shadow' })
    const clips = stripClips(planStrips(opts), opts, 'v2', 'p')
    expect(clips[0].color.brightness).toBeLessThan(0)
  })
})
