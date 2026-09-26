import { describe, it, expect } from 'vitest'
import type { Clip, MediaAsset } from '@shared/timeline'
import {
  ATEMPO_MIN,
  MAX_SPEED,
  MIN_SPEED,
  atempoChain,
  clipSpeed,
  durationAtSpeed,
  formatSpeed,
  isNormalSpeed,
  maxDurationAtSpeed,
  sourceFrameAt,
  sourceFramesFor,
  speedVideoFilter,
  withClipSpeed,
  clipRamp,
  clipRateAt,
  rampDuration,
  rampRate,
  rampSourceAt,
  rampSourceSeconds,
  rampVideoFilter,
  withClipRamp
} from '@shared/render/speed'
import { emptyProject, type Project } from '@shared/timeline'

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c',
  assetId: 'a',
  trackId: 'v1',
  start: 0,
  duration: 60,
  inPoint: 0,
  volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 },
  ...over
})

const video: MediaAsset = {
  id: 'a', path: '/v.mp4', name: 'v.mp4', kind: 'video', durationFrames: 300,
  width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, size: 0
}
const still: MediaAsset = { ...video, kind: 'image', durationFrames: 30, hasAudio: false }

describe('clipSpeed', () => {
  it('is one when unset', () => {
    expect(clipSpeed(clip())).toBe(1)
    expect(isNormalSpeed(clip())).toBe(true)
  })

  it('refuses nonsense rather than producing a broken graph', () => {
    // A zero or negative rate divides by zero inside setpts; NaN poisons every
    // number downstream. Falling back to 1 keeps a bad value from reaching ffmpeg.
    expect(clipSpeed(clip({ speed: 0 }))).toBe(1)
    expect(clipSpeed(clip({ speed: -2 }))).toBe(1)
    expect(clipSpeed(clip({ speed: Number.NaN }))).toBe(1)
  })

  it('clamps to the usable range', () => {
    expect(clipSpeed(clip({ speed: 99 }))).toBe(MAX_SPEED)
    expect(clipSpeed(clip({ speed: 0.001 }))).toBe(MIN_SPEED)
  })
})

describe('source consumed', () => {
  it('is the timeline length at normal speed', () => {
    expect(sourceFramesFor(clip({ duration: 60 }))).toBe(60)
  })

  it('is less when slowed — that is the whole point', () => {
    expect(sourceFramesFor(clip({ duration: 120, speed: 0.5 }))).toBe(60)
  })

  it('is more when sped up', () => {
    expect(sourceFramesFor(clip({ duration: 60, speed: 2 }))).toBe(120)
  })
})

describe('sourceFrameAt', () => {
  it('walks the source at half rate through a slowed clip', () => {
    const c = clip({ start: 30, inPoint: 100, speed: 0.5 })
    expect(sourceFrameAt(c, 30)).toBe(100)
    expect(sourceFrameAt(c, 50)).toBe(110)
    expect(sourceFrameAt(c, 90)).toBe(130)
  })

  it('walks it at double rate through a fast clip', () => {
    const c = clip({ start: 0, inPoint: 0, speed: 2 })
    expect(sourceFrameAt(c, 30)).toBe(60)
  })
})

describe('durationAtSpeed', () => {
  it('doubles the length at half speed, keeping the same footage', () => {
    expect(durationAtSpeed(clip({ duration: 60 }), video, 0.5)).toBe(120)
  })

  it('halves it at double speed', () => {
    expect(durationAtSpeed(clip({ duration: 60 }), video, 2)).toBe(30)
  })

  it('round-trips back to where it started', () => {
    const slowed = clip({ duration: durationAtSpeed(clip({ duration: 60 }), video, 0.25), speed: 0.25 })
    expect(slowed.duration).toBe(240)
    expect(durationAtSpeed(slowed, video, 1)).toBe(60)
  })

  it('will not run past the end of the footage', () => {
    // 300 frames of source, starting 240 in: only 60 are left, so at 2x the
    // clip cannot be longer than 30 timeline frames.
    const c = clip({ duration: 60, inPoint: 240 })
    expect(durationAtSpeed(c, video, 2)).toBe(30)
  })

  it('lets a still be held for as long as anyone likes', () => {
    expect(maxDurationAtSpeed(clip(), still, 4)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('speedVideoFilter', () => {
  it('emits nothing at normal speed', () => {
    expect(speedVideoFilter(1, 30)).toBeNull()
  })

  it('retimes and restores the frame count', () => {
    // setpts alone leaves the same frames spread thinner — a stream claiming
    // 30fps while delivering 15. The fps filter is what makes it a real clip.
    const f = speedVideoFilter(0.5, 30)
    expect(f).toContain('setpts=PTS/0.5')
    expect(f).toContain('fps=30')
  })

  it('interpolates only when asked, and only when slowing down', () => {
    expect(speedVideoFilter(0.5, 30, true)).toContain('minterpolate')
    // Speeding up throws frames away; there is nothing to invent.
    expect(speedVideoFilter(2, 30, true)).not.toContain('minterpolate')
  })
})

describe('atempoChain', () => {
  it('emits nothing at normal speed', () => {
    expect(atempoChain(1)).toEqual([])
  })

  it('uses one filter when one is in range', () => {
    expect(atempoChain(2)).toEqual(['atempo=2'])
  })

  it('chains below atempo’s floor', () => {
    // Measured against the binary: 0.4 is refused outright, so a quarter has to
    // be reached as two halvings.
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5'])
  })

  it('never emits a link outside the accepted range', () => {
    for (const speed of [0.1, 0.15, 0.25, 0.3, 0.5, 0.75, 1.5, 3, 8]) {
      for (const step of atempoChain(speed)) {
        const value = Number(step.split('=')[1])
        expect(value, `${speed} produced ${step}`).toBeGreaterThanOrEqual(ATEMPO_MIN)
        expect(value).toBeLessThanOrEqual(100)
      }
    }
  })

  it('multiplies back to the speed it was asked for', () => {
    for (const speed of [0.1, 0.2, 0.25, 0.4, 0.5, 0.8, 1.5, 2, 4, 8]) {
      const product = atempoChain(speed).reduce((n, s) => n * Number(s.split('=')[1]), 1)
      expect(Math.abs(product - speed), `${speed} -> ${product}`).toBeLessThan(0.002)
    }
  })
})

describe('formatSpeed', () => {
  it('reads the way people say it', () => {
    expect(formatSpeed(1)).toBe('1×')
    expect(formatSpeed(2)).toBe('2×')
    expect(formatSpeed(0.5)).toBe('0.5×')
  })
})

describe('withClipSpeed', () => {
  const build = (): Project => ({
    ...emptyProject(),
    settings: { width: 1080, height: 1920, fps: 30, sampleRate: 48000 },
    assets: [video, { ...still, id: 'img' }],
    clips: [
      clip({ id: 'a', assetId: 'a', trackId: 'v1', start: 0, duration: 60 }),
      clip({ id: 'b', assetId: 'a', trackId: 'v1', start: 60, duration: 60 }),
      // A different track must not be disturbed by a ripple on this one.
      clip({ id: 'other', assetId: 'a', trackId: 'v2', start: 60, duration: 60 })
    ]
  })
  const find = (p: Project, id: string): Clip => p.clips.find((c) => c.id === id)!

  it('lengthens the clip and pushes what follows it', () => {
    const next = withClipSpeed(build(), 'a', 0.5)
    expect(find(next, 'a').duration).toBe(120)
    // b sat at 60 directly after a; a grew by 60, so b moves to 120.
    expect(find(next, 'b').start).toBe(120)
    expect(find(next, 'b').duration).toBe(60)
  })

  it('pulls what follows back when the clip shortens', () => {
    const next = withClipSpeed(build(), 'a', 2)
    expect(find(next, 'a').duration).toBe(30)
    expect(find(next, 'b').start).toBe(30)
  })

  it('leaves other tracks exactly where they were', () => {
    const next = withClipSpeed(build(), 'a', 0.5)
    expect(find(next, 'other').start).toBe(60)
  })

  it('does not move anything that starts before the clip ends', () => {
    // A clip layered over the one being retimed is not "after" it, so pushing
    // it would silently break a deliberate overlap.
    const project = build()
    project.clips.push(clip({ id: 'over', assetId: 'a', trackId: 'v1', start: 30, duration: 10 }))
    const next = withClipSpeed(project, 'a', 0.5)
    expect(find(next, 'over').start).toBe(30)
  })

  it('drops the fields entirely when returning to normal', () => {
    const slowed = withClipSpeed(build(), 'a', 0.5)
    const back = withClipSpeed(slowed, 'a', 1)
    expect(find(back, 'a').speed).toBeUndefined()
    expect(find(back, 'a').smoothSlow).toBeUndefined()
    expect(find(back, 'a').duration).toBe(60)
  })

  it('keeps the smooth choice across a speed change', () => {
    const first = withClipSpeed(build(), 'a', 0.5, true)
    expect(find(first, 'a').smoothSlow).toBe(true)
    const slower = withClipSpeed(first, 'a', 0.25)
    expect(find(slower, 'a').smoothSlow).toBe(true)
  })

  it('refuses to retime a photograph', () => {
    const project = build()
    project.clips[0] = { ...project.clips[0], assetId: 'img' }
    const next = withClipSpeed(project, 'a', 0.5)
    expect(next).toBe(project)
  })

  it('ignores a clip that is not there', () => {
    const project = build()
    expect(withClipSpeed(project, 'nope', 0.5)).toBe(project)
  })
})

describe('speed ramps (docs/EFFECTS.md §18)', () => {
  it('last as long as the integral of 1/speed says: 2 s of 1× → 0.25× plays for 3.697 s', () => {
    // §18: predicted 3.697 s, ffmpeg returned 3.70 s.
    expect(rampDuration(1, 0.25, 2)).toBeCloseTo((2 / -0.75) * Math.log(0.25), 9)
    expect(rampDuration(1, 0.25, 2)).toBeCloseTo(3.697, 3)
    expect(rampSourceSeconds(1, 0.25, rampDuration(1, 0.25, 2))).toBeCloseTo(2, 9)
    // A flat "ramp" is a constant speed.
    expect(rampRate(0.5, 0.5)).toBe(0.5)
  })

  it('walk the footage the way ffmpeg did: 1, 2 and 3 s into that ramp are source frames 25, 42 and 54', () => {
    const at = (t: number): number => rampSourceAt(1, 0.25, 60, t * 30)
    expect(at(1)).toBeCloseTo(25, 0)
    expect(Math.abs(at(2) - 42)).toBeLessThan(1)
    expect(at(3)).toBeCloseTo(54, 0)
    // A constant stretch over the same length would have been at 16, 32 and 49 (§18).
    expect(at(1)).toBeGreaterThan(20)
  })

  it('size every decode window by the footage, not the output — and the preview seeks along the curve', () => {
    const ramped = clip({ duration: 111, ramp: { from: 1, to: 0.25 } })
    // 111 frames of output at a mean rate of 0.541: 60 frames of footage, not 111.
    expect(sourceFramesFor(ramped)).toBe(Math.ceil(111 * rampRate(1, 0.25) - 1e-9))
    expect(sourceFramesFor(ramped)).toBe(61)
    expect(sourceFrameAt(ramped, 30)).toBe(Math.round(rampSourceAt(1, 0.25, 111 * rampRate(1, 0.25), 30)))
    // It decelerates: the first second covers more footage than the last.
    expect(sourceFrameAt(ramped, 30) - sourceFrameAt(ramped, 0)).toBeGreaterThan(sourceFrameAt(ramped, 110) - sourceFrameAt(ramped, 80))
    expect(clipRateAt(ramped, 0)).toBeCloseTo(1, 6)
    expect(clipRateAt(ramped, 111)).toBeCloseTo(0.25, 2)
  })

  it('are one setpts with a log, then fps — and a flat one is a plain speed', () => {
    const f = rampVideoFilter(1, 0.25, 2, 30)
    expect(f).toMatch(/^setpts='.*log\(.*\)\/TB',fps=30$/)
    expect(f).toContain('T-STARTT')
    expect(rampVideoFilter(0.5, 0.5, 2, 30)).toBe('setpts=PTS/0.5,fps=30')
  })

  it('are clamped to a quarter and four, and refuse nonsense', () => {
    expect(clipRamp({ ramp: { from: 0.1, to: 9 } })).toEqual({ from: 0.25, to: 4 })
    expect(clipRamp({ ramp: { from: 0, to: 1 } })).toBeNull()
    expect(clipRamp({})).toBeNull()
  })

  it('keep the same footage when applied, move what follows, replace a speed, and never ramp a still', () => {
    const p: Project = {
      ...emptyProject(),
      assets: [video, { ...still, id: 'img' }],
      clips: [clip({ id: 'a', duration: 60, speed: 2 }), clip({ id: 'b', start: 60, duration: 30 })]
    }
    // At 2× the clip eats 120 frames; ramped 1× → 0.25× those 120 play over 221.
    const next = withClipRamp(p, 'a', { from: 1, to: 0.25 })
    const a = next.clips.find((c) => c.id === 'a')!
    expect(a.speed).toBeUndefined()
    expect(a.duration).toBe(Math.floor(120 / rampRate(1, 0.25)))
    expect(sourceFramesFor(a)).toBeLessThanOrEqual(120)
    expect(next.clips.find((c) => c.id === 'b')!.start).toBe(60 + (a.duration - 60))
    const off = withClipRamp(next, 'a', null)
    expect(off.clips.find((c) => c.id === 'a')!.ramp).toBeUndefined()
    const photo = { ...p, clips: [clip({ id: 'a', assetId: 'img' })] }
    expect(withClipRamp(photo, 'a', { from: 1, to: 0.5 })).toBe(photo)
  })
})
