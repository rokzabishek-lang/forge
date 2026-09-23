import { describe, it, expect } from 'vitest'
import { basename } from 'node:path'
import {
  RESOLUTIONS,
  exportCanvas,
  exportRange,
  formatRemaining,
  isResolution,
  timeRemainingMs,
  withContainerExtension
} from '@shared/render/exportShape'
import { ASPECTS, aspectOf } from '@shared/render/aspect'

describe('export resolution', () => {
  it('is a multiplier on the aspect, giving the canvases FIX.md B2 asks for', () => {
    expect(exportCanvas('16:9', '4k')).toEqual({ width: 3840, height: 2160 })
    expect(exportCanvas('9:16', '4k')).toEqual({ width: 2160, height: 3840 })
    expect(exportCanvas('1:1', '4k')).toEqual({ width: 2160, height: 2160 })
    expect(exportCanvas('16:9', '720p')).toEqual({ width: 1280, height: 720 })
    expect(exportCanvas('9:16', '720p')).toEqual({ width: 720, height: 1280 })
    expect(exportCanvas('16:9', '1080p')).toEqual({ width: 1920, height: 1080 })
  })

  it('keeps the shape: every size of an aspect still reads as that aspect', () => {
    // Why sizes are not new ASPECTS entries: aspectOf matches on the ratio.
    for (const key of Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]) {
      for (const r of RESOLUTIONS) {
        expect(aspectOf(exportCanvas(key, r.id)), `${key} ${r.id}`).toBe(key)
      }
    }
  })

  it('is always even, which 4:2:0 chroma requires', () => {
    for (const key of Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]) {
      for (const r of RESOLUTIONS) {
        const { width, height } = exportCanvas(key, r.id)
        expect(width % 2, `${key} ${r.id}`).toBe(0)
        expect(height % 2, `${key} ${r.id}`).toBe(0)
      }
    }
  })

  it('knows its own ids and nothing else', () => {
    expect(isResolution('4k')).toBe(true)
    expect(isResolution('8k')).toBe(false)
    expect(isResolution(undefined)).toBe(false)
  })
})

describe('export range', () => {
  it('is the whole edit when nothing is marked, or the marks cover it all', () => {
    expect(exportRange(null, null, 300)).toBeNull()
    expect(exportRange(0, 300, 300)).toBeNull()
    expect(exportRange(0, 900, 300)).toBeNull()
  })

  it('takes the marks as [in, out), and either alone runs to the edge', () => {
    expect(exportRange(30, 90, 300)).toEqual({ start: 30, end: 90 })
    expect(exportRange(30, null, 300)).toEqual({ start: 30, end: 300 })
    expect(exportRange(null, 90, 300)).toEqual({ start: 0, end: 90 })
  })

  it('clamps an out point left past the end, and rounds to whole frames', () => {
    expect(exportRange(30, 500, 300)).toEqual({ start: 30, end: 300 })
    expect(exportRange(29.6, 90.4, 300)).toEqual({ start: 30, end: 90 })
  })

  it('calls an empty range empty, rather than quietly exporting everything', () => {
    expect(exportRange(300, null, 300)).toBe('empty')
    expect(exportRange(120, 120.2, 300)).toBe('empty')
  })
})

describe('the exported file’s name', () => {
  it('carries the container’s extension, whatever it was chosen with', () => {
    expect(withContainerExtension('/out/Wedding reel.mp4', 'mov')).toBe('/out/Wedding reel.mov')
    expect(withContainerExtension('/out/Wedding reel.mov', 'mp4')).toBe('/out/Wedding reel.mp4')
    expect(withContainerExtension('/out/Wedding reel', 'mp4')).toBe('/out/Wedding reel.mp4')
  })

  it('never mistakes a dot in the name, or in a folder, for the extension', () => {
    expect(basename(withContainerExtension('/out/v1.2 final', 'mov'))).toBe('v1.2 final.mov')
    expect(withContainerExtension('C:\\Users\\a.b\\reel', 'mp4')).toBe('C:\\Users\\a.b\\reel.mp4')
  })
})

describe('time remaining', () => {
  it('extrapolates from the rate so far', () => {
    // A quarter done in 30 s: three quarters to go at the same rate is 90 s.
    expect(timeRemainingMs(0.25, 0, 30_000)).toBeCloseTo(90_000, 6)
    expect(timeRemainingMs(0.5, 1_000, 61_000)).toBeCloseTo(60_000, 6)
  })

  it('says nothing until the estimate means something', () => {
    expect(timeRemainingMs(0.25, null, 30_000)).toBeNull()
    // The first seconds are spent opening files and building the graph.
    expect(timeRemainingMs(0.25, 0, 2_000)).toBeNull()
    expect(timeRemainingMs(0.01, 0, 30_000)).toBeNull()
    expect(timeRemainingMs(1, 0, 30_000)).toBeNull()
    expect(timeRemainingMs(Number.NaN, 0, 30_000)).toBeNull()
  })

  it('reads the way someone waiting reads it', () => {
    expect(formatRemaining(38_000)).toBe('40 s left')
    expect(formatRemaining(1_000)).toBe('5 s left')
    expect(formatRemaining(4 * 60_000 + 10_000)).toBe('about 4 min left')
    expect(formatRemaining(95 * 60_000)).toBe('about 1 h 35 min left')
  })
})
