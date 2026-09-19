import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bucketsForSource, clipBars } from '@shared/render/waveBars'

/*
 * The bars a clip's waveform is drawn from.
 *
 * Almost everything here is about the MAPPING rather than the drawing: a clip
 * shows a window of its source, and the peaks array spans the whole file. A
 * waveform of the wrong part of the sound looks exactly as convincing as a
 * waveform of the right part, which is why these are assertions about where
 * the loud bit lands rather than about whether anything was produced.
 */

const FPS = 30

/**
 * Peaks with a single loud burst, so its POSITION can be asserted.
 *
 * `loudFrom`/`loudTo` are bucket indices. Everything else is near silence.
 */
function peaks(buckets: number, loudFrom: number, loudTo: number): number[] {
  const values: number[] = []
  for (let i = 0; i < buckets; i++) {
    const loud = i >= loudFrom && i < loudTo
    const amp = loud ? 1 : 0.02
    values.push(-amp, amp)
  }
  return values
}

/** Where the tall bars are, as a fraction across the drawn width. */
function loudSpan(
  bars: { x: number; width: number; height: number }[],
  width: number
): { from: number; to: number } | null {
  const tallest = Math.max(...bars.map((b) => b.height))
  const loud = bars.filter((b) => b.height > tallest * 0.5)
  if (loud.length === 0) return null
  return {
    from: Math.min(...loud.map((b) => b.x)) / width,
    to: Math.max(...loud.map((b) => b.x + b.width)) / width
  }
}

describe('clipBars', () => {
  it('puts the loud part where the clip actually shows it', () => {
    // The file is 100 buckets long and loud from 50 to 60 — halfway through.
    // A clip showing the whole file must show the burst halfway across.
    const bars = clipBars({
      values: peaks(100, 50, 60),
      buckets: 100,
      analysedFrames: 300,
      inPoint: 0,
      sourceFrames: 300,
      width: 400,
      height: 40
    })
    const span = loudSpan(bars, 400)!
    expect(span.from).toBeGreaterThan(0.46)
    expect(span.to).toBeLessThan(0.64)
  })

  it('follows the in point — a trimmed clip shows a different part of the file', () => {
    /*
     * The same file, but the clip starts at the halfway mark and runs to the
     * end. The burst is now at the very START of the clip.
     *
     * This is the assertion that fails if `inPoint` is ignored, which is the
     * single easiest thing to get wrong here: the waveform still appears, still
     * has a burst in it, and is still of the wrong moment.
     */
    const bars = clipBars({
      values: peaks(100, 50, 60),
      buckets: 100,
      analysedFrames: 300,
      inPoint: 150,
      sourceFrames: 150,
      width: 400,
      height: 40
    })
    const span = loudSpan(bars, 400)!
    expect(span.from).toBeLessThan(0.04)
    expect(span.to).toBeLessThan(0.25)
  })

  it('follows speed — half speed shows half as much file over the same width', () => {
    /*
     * A clip at 0.5× consumes `duration × speed` frames of source, so a clip
     * of the same timeline length covers half the file. With the burst at the
     * halfway mark of the FILE, a half-speed clip from the start never reaches
     * it; it sits exactly at the clip's right-hand edge.
     */
    const full = clipBars({
      values: peaks(100, 48, 52),
      buckets: 100,
      analysedFrames: 300,
      inPoint: 0,
      sourceFrames: 300,
      width: 400,
      height: 40
    })
    const halved = clipBars({
      values: peaks(100, 48, 52),
      buckets: 100,
      analysedFrames: 300,
      inPoint: 0,
      // duration 300 at 0.5× consumes 150 frames of source
      sourceFrames: 150,
      width: 400,
      height: 40
    })
    expect(loudSpan(full, 400)!.from).toBeCloseTo(0.48, 1)
    expect(loudSpan(halved, 400)!.from).toBeGreaterThan(0.9)
  })

  it('keeps a transient that falls between samples', () => {
    /*
     * One loud bucket in two thousand, drawn into two hundred pixels. Sampling
     * every Nth bucket loses it with probability 19 in 20; aggregating cannot.
     *
     * This is not a hypothetical tidiness: a waveform whose snare disappears
     * and reappears as you zoom is worse than no waveform, because you stop
     * trusting the one you are cutting against.
     */
    const bars = clipBars({
      values: peaks(2000, 997, 998),
      buckets: 2000,
      analysedFrames: 6000,
      inPoint: 0,
      sourceFrames: 6000,
      width: 200,
      height: 40
    })
    const span = loudSpan(bars, 200)
    expect(span).not.toBeNull()
    expect(span!.from).toBeGreaterThan(0.44)
    expect(span!.to).toBeLessThan(0.56)
  })

  it('draws nothing past the end of the sound', () => {
    /*
     * A ten-second video carrying eight seconds of audio. The last fifth of
     * the clip has no peaks behind it, and must be blank rather than a smear
     * of the last bucket — an invented tail is a lie about the file.
     */
    const bars = clipBars({
      values: peaks(80, 0, 80),
      buckets: 80,
      analysedFrames: 240,
      inPoint: 0,
      sourceFrames: 300,
      width: 300,
      height: 40
    })
    const rightmost = Math.max(...bars.map((b) => b.x + b.width))
    expect(rightmost).toBeLessThanOrEqual(246)
    expect(rightmost).toBeGreaterThan(230)
  })

  it('centres the bars and scales them by loudness', () => {
    const quiet = clipBars({
      values: peaks(10, 0, 0),
      buckets: 10,
      analysedFrames: 30,
      inPoint: 0,
      sourceFrames: 30,
      width: 40,
      height: 40
    })
    const loud = clipBars({
      values: peaks(10, 0, 10),
      buckets: 10,
      analysedFrames: 30,
      inPoint: 0,
      sourceFrames: 30,
      width: 40,
      height: 40
    })
    // Symmetric about the middle in both cases.
    for (const bars of [quiet, loud]) {
      for (const bar of bars) expect(bar.top + bar.height / 2).toBeCloseTo(20, 5)
    }
    expect(loud[0].height).toBeGreaterThan(quiet[0].height * 5)
    // And it stays inside the box.
    expect(loud[0].top).toBeGreaterThanOrEqual(0)
    expect(loud[0].top + loud[0].height).toBeLessThanOrEqual(40)
  })

  it('returns nothing rather than throwing on degenerate input', () => {
    const base = {
      values: peaks(10, 0, 10),
      buckets: 10,
      analysedFrames: 30,
      inPoint: 0,
      sourceFrames: 30,
      width: 40,
      height: 40
    }
    expect(clipBars({ ...base, values: [], buckets: 0 })).toEqual([])
    expect(clipBars({ ...base, width: 0 })).toEqual([])
    expect(clipBars({ ...base, height: 0 })).toEqual([])
    expect(clipBars({ ...base, analysedFrames: 0 })).toEqual([])
    expect(clipBars({ ...base, sourceFrames: 0 })).toEqual([])
  })

  it('believes the array, not a count that overstates it', () => {
    /*
     * `peaksFor` derives `buckets` from the array it built, so the two agree —
     * but the harness stub returned one number per bucket instead of a pair
     * for months, and nothing caught it. Under a count that claims five times
     * the data, indexing by the count squeezes the entire waveform into the
     * first fifth of the clip and leaves the rest blank. It looks like a short
     * file, not like a bug.
     *
     * Reading undefined does not throw here — the crest/trough comparison
     * quietly rejects it — so "no NaN" is not the assertion that matters. The
     * assertion is that the sound still spans the clip.
     */
    const bars = clipBars({
      values: peaks(20, 0, 20),
      buckets: 100,
      analysedFrames: 300,
      inPoint: 0,
      sourceFrames: 300,
      width: 200,
      height: 40
    })
    expect(bars.length).toBeGreaterThan(0)
    const rightmost = Math.max(...bars.map((b) => b.x + b.width))
    expect(rightmost).toBeGreaterThan(190)
    for (const bar of bars) {
      expect(Number.isFinite(bar.top)).toBe(true)
      expect(Number.isFinite(bar.height)).toBe(true)
    }
  })
})

describe('bucketsForSource', () => {
  it('asks for more buckets for a longer file', () => {
    expect(bucketsForSource(FPS * 30, FPS)).toBeLessThan(bucketsForSource(FPS * 180, FPS))
  })

  it('stays useful at both extremes', () => {
    // A half-second whip: a floor, so there is something to draw.
    expect(bucketsForSource(15, FPS)).toBe(200)
    // An hour-long recording: a ceiling, so the IPC payload stays sane.
    expect(bucketsForSource(FPS * 3600, FPS)).toBe(4000)
    expect(bucketsForSource(0, FPS)).toBe(200)
  })

  it('never asks for more buckets than the IPC will pass on', () => {
    /*
     * `media:peaks` clamps what it is given. Asking for more than the ceiling
     * does not fail — it silently returns fewer, and the renderer caches the
     * answer under the number it ASKED for. Nothing breaks visibly; the file
     * just gets decoded again the next time something asks for the real
     * ceiling, and the cache quietly holds two copies of the same peaks.
     */
    const handler = readFileSync(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
    const clamp = /Math\.max\(64, Math\.min\((\d+), buckets\)\)/.exec(handler)
    expect(clamp).not.toBeNull()
    const ceiling = Number(clamp![1])
    expect(bucketsForSource(30 * 3600, 30)).toBeLessThanOrEqual(ceiling)
  })

  it('gives a two-second clip cut from a long file something to show', () => {
    /*
     * The reason this is not a constant. A fixed 600 buckets over a ten-minute
     * podcast is one bucket a second, so a two-second answer lifted out of it
     * gets two bars — a waveform you cannot cut against.
     */
    const buckets = bucketsForSource(FPS * 600, FPS)
    const perSecond = buckets / 600
    expect(perSecond * 2).toBeGreaterThan(12)
  })
})
