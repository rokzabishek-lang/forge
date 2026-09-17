import { describe, it, expect } from 'vitest'
import { ASPECTS, aspectOf } from '@shared/render/aspect'

/*
 * Which aspect a project's settings describe.
 *
 * `aspect` is a slice of its own, initialised to 16:9, and opening a saved file
 * never touched it — while every reframe decision reads ASPECTS[aspect] rather
 * than project.settings. So a 9:16 project reopened into a fresh session looked
 * right, and the next clip dropped onto it was cropped to a horizontal
 * rectangle inside a vertical frame, for no reason the user could see.
 */

describe('aspectOf', () => {
  it('recognises each of the app\'s own canvases', () => {
    for (const key of Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]) {
      expect(aspectOf(ASPECTS[key]), key).toBe(key)
    }
  })

  it('matches on the ratio, not the exact pixels', () => {
    // A project saved at another resolution of the same shape is still vertical.
    expect(aspectOf({ width: 720, height: 1280 })).toBe('9:16')
    expect(aspectOf({ width: 3840, height: 2160 })).toBe('16:9')
    expect(aspectOf({ width: 2048, height: 2048 })).toBe('1:1')
  })

  it('picks the nearest shape for something in between', () => {
    // 4:3 is closer to square than to either wide shape.
    expect(aspectOf({ width: 1024, height: 768 })).toBe('1:1')
    // 2:1 cinematic is nearest 16:9.
    expect(aspectOf({ width: 2000, height: 1000 })).toBe('16:9')
  })

  it('never divides by zero on a malformed project', () => {
    expect(() => aspectOf({ width: 100, height: 0 })).not.toThrow()
    expect(Object.keys(ASPECTS)).toContain(aspectOf({ width: 100, height: 0 }))
  })
})
