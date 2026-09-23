import { describe, it, expect } from 'vitest'
import { isNeutralBalance, whiteBalanceFilter, whiteBalanceGains } from '@shared/render/whiteBalance'
import { buildRenderPlan } from '@shared/render/plan'
import { defaultMask } from '@shared/render/mask'
import {
  NEUTRAL_COLOR_PATCH,
  emptyProject,
  isNeutralGrade,
  type Clip,
  type ColorAdjust,
  type MediaAsset,
  type Project
} from '@shared/timeline'

/*
 * Temperature and tint (FIX.md B3): three channel gains, one function for the
 * preview's shader and the export's colorchannelmixer.
 */

const luma = (g: { r: number; g: number; b: number }): number => 0.2126 * g.r + 0.7152 * g.g + 0.0722 * g.b

describe('white balance gains', () => {
  it('are exactly 1, 1, 1 at neutral, and nothing is emitted', () => {
    expect(whiteBalanceGains(0, 0)).toEqual({ r: 1, g: 1, b: 1 })
    expect(whiteBalanceGains(undefined, undefined)).toEqual({ r: 1, g: 1, b: 1 })
    expect(whiteBalanceFilter(0, 0)).toBeNull()
    expect(isNeutralBalance(undefined, undefined)).toBe(true)
  })

  it('warm is more red and less blue; cool the other way', () => {
    const warm = whiteBalanceGains(1, 0)
    expect(warm.r).toBeGreaterThan(1)
    expect(warm.b).toBeLessThan(1)
    const cool = whiteBalanceGains(-1, 0)
    expect(cool.r).toBeLessThan(1)
    expect(cool.b).toBeGreaterThan(1)
  })

  it('tint trades green against magenta', () => {
    expect(whiteBalanceGains(0, 1).g).toBeLessThan(whiteBalanceGains(0, 0).g)
    expect(whiteBalanceGains(0, -1).g).toBeGreaterThan(whiteBalanceGains(0, 0).g)
  })

  it('keeps a grey as bright as it was, whatever the balance', () => {
    for (const [t, k] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.6, -0.4], [-0.3, 0.8]]) {
      expect(luma(whiteBalanceGains(t, k)), `${t},${k}`).toBeCloseTo(1, 9)
    }
  })

  it('treats anything out of range or not a number as the nearest edge, or neutral', () => {
    expect(whiteBalanceGains(5, 0)).toEqual(whiteBalanceGains(1, 0))
    expect(whiteBalanceGains(Number.NaN, 0)).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('is a colorchannelmixer — never colortemperature, which the 2018 Windows build lacks', () => {
    const filter = whiteBalanceFilter(0.5, 0)!
    expect(filter).toMatch(/^colorchannelmixer=rr=[\d.]+:gg=[\d.]+:bb=[\d.]+$/)
    expect(filter).not.toContain('colortemperature')
  })
})

describe('a grade with a white balance is a grade', () => {
  it('is not neutral, so the preview and the export both apply it', () => {
    expect(isNeutralGrade({ brightness: 0, contrast: 1, saturation: 1, temperature: 0.3 })).toBe(false)
    expect(isNeutralGrade({ brightness: 0, contrast: 1, saturation: 1, tint: -0.2 })).toBe(false)
  })

  it('Reset takes every part of it off — curves and the balance included', () => {
    const graded: ColorAdjust = {
      brightness: 0.2, contrast: 1.4, saturation: 0.5, temperature: 0.7, tint: -0.3,
      curves: { master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] } as ColorAdjust['curves'],
      lut: { file: '/l.cube', intensity: 0.8 }
    }
    expect(isNeutralGrade({ ...graded, ...NEUTRAL_COLOR_PATCH })).toBe(true)
  })
})

describe('where the export applies it', () => {
  const asset: MediaAsset = {
    id: 'a', path: '/m/a.mp4', name: 'a.mp4', kind: 'video', durationFrames: 300,
    width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, size: 1
  }
  const clip = (over: Partial<Clip> = {}): Clip => ({
    id: 'c', assetId: 'a', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0.1, contrast: 1, saturation: 1, temperature: 0.5 },
    ...over
  })
  const graph = (clips: Clip[]): string => {
    const project: Project = { ...emptyProject(), assets: [asset], clips }
    const args = buildRenderPlan({ project, outputPath: '/o.mp4' }).args
    return args[args.indexOf('-filter_complex') + 1]
  }
  const mixer = whiteBalanceFilter(0.5, 0)!

  it('before the sliders in a clip’s own chain: correct the light, then grade', () => {
    const g = graph([clip()])
    expect(g).toContain(mixer)
    expect(g.indexOf(mixer)).toBeLessThan(g.indexOf('eq=brightness='))
  })

  it('on an adjustment layer, gated to its time like the rest of its grade', () => {
    const g = graph([clip({ id: 'shot', color: { brightness: 0, contrast: 1, saturation: 1 } }),
      clip({ id: 'adj', trackId: 'v2', adjustment: true } as Partial<Clip>)])
    expect(g).toContain(`${mixer}:enable='between(t,`)
  })

  it('inside a colour mask, with the other colour filters', () => {
    // In 'grade' mode the clip's own chain grades nothing — only the inside of
    // the shape is graded — so this is the one place the mixer can come from.
    const g = graph([clip({ mask: defaultMask('grade') })])
    expect(g).toContain(mixer)
    expect(g.indexOf(mixer)).toBeLessThan(g.indexOf('eq=brightness='))
  })
})
