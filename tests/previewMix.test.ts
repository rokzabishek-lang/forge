import { describe, it, expect } from 'vitest'
import { fadeGainAt, clipFades, FADE_CURVE } from '@shared/render/audioFade'
import { DUCK, duckFilter, duckStep, duckTarget } from '@shared/render/duck'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The preview's mix, held to the export's.
 *
 * Every level in the preview is now a gain in a Web Audio graph, and each one
 * is computed by the function the EXPORT uses — `valueAt` for the envelope,
 * `fadeGainAt` for the fades, `duckStep` for the ducker. The graph itself can
 * only be checked by running it, so what is checked here is the arithmetic it
 * is fed: if these agree with what ffmpeg is asked to do, the two mixes agree.
 */

describe('fadeGainAt walks the same curve afade walks', () => {
  const clip = (over: Partial<Pick<Clip, 'fadeIn' | 'fadeOut' | 'duration'>>) => ({
    duration: 100,
    ...over
  })

  it('is silent at the very start of a fade-in and open at its end', () => {
    const c = clip({ fadeIn: 20 })
    expect(fadeGainAt(c, 0)).toBe(0)
    expect(fadeGainAt(c, 20)).toBeCloseTo(1, 6)
    expect(fadeGainAt(c, 50)).toBe(1)
  })

  it('is open at the start of a fade-out and silent at its end', () => {
    const c = clip({ fadeOut: 20 })
    expect(fadeGainAt(c, 80)).toBeCloseTo(1, 6)
    expect(fadeGainAt(c, 100)).toBe(0)
    expect(fadeGainAt(c, 50)).toBe(1)
  })

  /*
   * Half way through a qsin fade is -3.01 dB — the equal-power point, and the
   * reason the crossfade below sums flat. A straight line in amplitude is at
   * -6.02 dB in the same place, which is the hole `tri` puts in the middle of
   * every crossfade and the reason FADE_CURVE is not it.
   *
   * Not to be confused with the dB table in audioFade.ts's comment: those are
   * quarter-second windows of a rendered tone, so they average a span of the
   * curve rather than sampling one instant of it.
   */
  it('is at the equal-power point half way, where a straight line is 3 dB lower', () => {
    expect(FADE_CURVE).toBe('qsin')
    const c = clip({ fadeOut: 20 })
    const halfway = fadeGainAt(c, 90)

    expect(20 * Math.log10(halfway)).toBeCloseTo(-3.0103, 3)
    expect(halfway).toBeCloseTo(Math.SQRT1_2, 6)
    // The linear value it must not be.
    expect(halfway).toBeGreaterThan(0.5)
  })

  it('is equal power across an overlap, which is why a crossfade does not dip', () => {
    /*
     * The outgoing clip's fade-out and the incoming clip's fade-in are the same
     * curve mirrored, so their squares sum to exactly one: the pair holds the
     * level either alone would have had. FIX.md asked for within 1 %; qsin
     * gives it exactly, and pinning the exact value is what would catch a
     * curve change.
     */
    const N = 30
    const out = clip({ duration: N, fadeOut: N })
    const into = clip({ duration: N, fadeIn: N })

    for (let k = 0; k <= N; k++) {
      const a = fadeGainAt(out, k)
      const b = fadeGainAt(into, k)
      expect(a * a + b * b, `at ${k}/${N}`).toBeCloseTo(1, 6)
    }
  })

  it('never returns a negative gain, whatever frame it is asked about', () => {
    // sin() of a negative argument is negative, and a negative gain is a phase
    // flip rather than silence — audible, and exactly the wrong thing.
    const c = clip({ fadeIn: 10, fadeOut: 10 })
    for (const frame of [-500, -1, 0, 100, 101, 5000]) {
      expect(fadeGainAt(c, frame), `frame ${frame}`).toBeGreaterThanOrEqual(0)
      expect(fadeGainAt(c, frame), `frame ${frame}`).toBeLessThanOrEqual(1)
    }
  })

  it('follows the fades that were squeezed to fit, not the ones asked for', () => {
    // Two fades longer than the clip are reduced in proportion by `clipFades`,
    // and the preview has to hear the reduced ones or it fades out early on a
    // clip the export plays through.
    const c = clip({ duration: 40, fadeIn: 30, fadeOut: 30 })
    const fades = clipFades(c)
    expect(fades.in + fades.out).toBe(40)
    // Silent only at the very ends, and at its loudest where the two meet.
    expect(fadeGainAt(c, 0)).toBe(0)
    expect(fadeGainAt(c, 40)).toBe(0)
    expect(fadeGainAt(c, fades.in)).toBeGreaterThan(0.99)
  })

  it('is flat for a clip with no fades at all', () => {
    const c = clip({})
    for (const frame of [0, 1, 50, 99, 100]) expect(fadeGainAt(c, frame)).toBe(1)
  })
})

describe('the ducker', () => {
  it('leaves the music alone below the threshold', () => {
    expect(duckTarget(0)).toBe(1)
    expect(duckTarget(DUCK.threshold)).toBe(1)
    expect(duckTarget(DUCK.threshold * 0.99)).toBe(1)
  })

  it('reduces by the ratio, which is what a ratio means', () => {
    // Twelve dB over the threshold at 12:1 comes out one dB over, so the gain
    // applied is the other eleven dB.
    const twelveDbOver = DUCK.threshold * 10 ** (12 / 20)
    const reductionDb = -20 * Math.log10(duckTarget(twelveDbOver))
    expect(reductionDb).toBeCloseTo(12 * (1 - 1 / DUCK.ratio), 6)
    expect(reductionDb).toBeCloseTo(11, 6)
  })

  it('moves by its own time constant in each direction', () => {
    /*
     * The whole character of a ducker. Without the asymmetry either the first
     * word is buried under music that has not moved yet, or the music pumps up
     * and down between every syllable.
     *
     * Measured as a FRACTION of the distance left to travel, which is the only
     * way to see it: falling has much further to go than rising does, so
     * comparing raw distances makes the two look asymmetric even when both are
     * using the same time constant — a test written that way passes with the
     * attack deleted, and this one did until the mutation run said so.
     */
    expect(DUCK.attackMs).toBeLessThan(DUCK.releaseMs)
    const loud = 0.5
    const target = duckTarget(loud)
    const reach = 1 - target
    const e = 1 - 1 / Math.E

    // One time constant covers 1-1/e of the remaining distance, by definition.
    expect((1 - duckStep(1, loud, DUCK.attackMs)) / reach).toBeCloseTo(e, 6)
    expect((duckStep(target, 0, DUCK.releaseMs) - target) / reach).toBeCloseTo(e, 6)

    // So over the same elapsed time it falls much further than it rises.
    const fell = (1 - duckStep(1, loud, 16)) / reach
    const rose = (duckStep(target, 0, 16) - target) / reach
    expect(fell).toBeGreaterThan(rose * 5)
  })

  it('settles where the static curve says, and comes back to one', () => {
    const loud = 0.5
    let gain = 1
    for (let i = 0; i < 400; i++) gain = duckStep(gain, loud, 16)
    expect(gain).toBeCloseTo(duckTarget(loud), 4)

    for (let i = 0; i < 400; i++) gain = duckStep(gain, 0, 16)
    expect(gain).toBeCloseTo(1, 4)
  })

  it('reaches the same place at 20 frames a second as at 60', () => {
    /*
     * Stepped by elapsed milliseconds rather than per frame, so a busy preview
     * does not duck more slowly than an idle one — the mix changing depending
     * on how hard the machine is working would be untrustworthy in exactly the
     * moments it matters.
     */
    const over = (stepMs: number, totalMs: number): number => {
      let gain = 1
      for (let t = 0; t < totalMs; t += stepMs) gain = duckStep(gain, 0.5, stepMs)
      return gain
    }
    expect(over(16.7, 500)).toBeCloseTo(over(50, 500), 2)
  })

  it('stays inside a usable range for any level it could be handed', () => {
    for (const level of [0, 1e-9, 0.001, 0.5, 1, 4, Number.MAX_SAFE_INTEGER]) {
      let gain = 1
      for (let i = 0; i < 50; i++) gain = duckStep(gain, level, 16)
      expect(gain, `level ${level}`).toBeGreaterThanOrEqual(0)
      expect(gain, `level ${level}`).toBeLessThanOrEqual(1)
      expect(Number.isFinite(gain), `level ${level}`).toBe(true)
    }
  })

  it('is the same ducker the render runs', () => {
    /*
     * One set of constants, two consumers. The filter string is built from
     * `DUCK`, so a threshold changed for the preview cannot leave the export
     * compressing at the old one.
     */
    const filter = duckFilter()
    expect(filter).toContain(`threshold=${DUCK.threshold}`)
    expect(filter).toContain(`ratio=${DUCK.ratio}`)
    expect(filter).toContain(`attack=${DUCK.attackMs}`)
    expect(filter).toContain(`release=${DUCK.releaseMs}`)

    const W = 320
    const H = 240
    const asset = (id: string, kind: MediaAsset['kind']): MediaAsset => ({
      id, path: `/tmp/${id}`, name: id, kind,
      durationFrames: 300, width: W, height: H, fps: 30,
      hasVideo: kind === 'video', hasAudio: true, size: 0
    })
    const project: Project = {
      ...emptyProject(),
      settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
        { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false, duck: true }
      ],
      assets: [asset('v', 'video'), asset('m', 'audio')],
      clips: [
        {
          id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          color: { brightness: 0, contrast: 1, saturation: 1 }
        },
        {
          id: 'm', assetId: 'm', trackId: 'a1', start: 0, duration: 60, inPoint: 0, volume: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          color: { brightness: 0, contrast: 1, saturation: 1 }
        }
      ]
    }
    const args = buildRenderPlan({ project, outputPath: '/o.mp4' }).args.join(' ')
    expect(args).toContain(filter)
  })
})
