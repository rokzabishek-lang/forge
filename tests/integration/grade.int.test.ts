import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type ColorAdjust, type MediaAsset, type Project } from '@shared/timeline'
import { applyCurves } from '@shared/render/colourCurve'

/*
 * Grading, rendered.
 *
 * `ColorAdjust` sat on every clip from the start and was read by nothing — no eq
 * filter, no preview filter, nothing. These tests exist so that cannot happen
 * again quietly: they render real frames and read the pixels back.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120

let dir = ''
let still = ''
let swapLut = ''

/** Swaps red and blue. Unmistakable, and asymmetric so a wrong axis order shows. */
const SWAP_CUBE = `# red <-> blue
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-grade-'))
  still = join(dir, 'red.png')
  swapLut = join(dir, 'swap.cube')
  await writeFile(swapLut, SWAP_CUBE)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=1:duration=1',
    '-frames:v', '1', still])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function gradedProject(color: ColorAdjust): Project {
  const asset: MediaAsset = {
    id: 'img', path: still, name: 'red.png', kind: 'image', durationFrames: 12,
    width: 320, height: 240, fps: 12, hasVideo: true, hasAudio: false, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'img', trackId: 'v1', start: 0, duration: 12, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 12, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

/** Render and read the centre pixel as RGB. */
async function centreColour(color: ColorAdjust): Promise<[number, number, number]> {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`)
  const plan = buildRenderPlan({ project: gradedProject(color), outputPath: out })
  await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })

  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', out,
     '-vf', `crop=2:2:${W / 2}:${H / 2}`, '-frames:v', '1',
     '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
  )
  const buffer = stdout as unknown as Buffer
  return [buffer[0], buffer[1], buffer[2]]
}

const NEUTRAL: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 }

describe('curves', () => {
  const LIFT = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.75 },
    { x: 1, y: 1 }
  ]

  it('emits no filter when every curve is the identity', () => {
    const plan = buildRenderPlan({
      project: gradedProject({ ...NEUTRAL, curves: { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }),
      outputPath: '/tmp/x.mp4'
    })
    expect(plan.args.join(' ')).not.toContain('curves=')
  })

  /*
   * The assertion that keeps the preview honest.
   *
   * ffmpeg interpolates curves with a natural cubic spline. Our own maths
   * predicts 0.921875 for this probe where a straight line would give 0.875 —
   * this renders it and checks the binary agrees.
   */
  it('interpolates with a spline, matching our own maths', async () => {
    /*
     * Measured against itself rather than against a number I worked out.
     *
     * The first version of this test assumed the desaturated source sat at mid
     * grey; it does not — the luma of red is about 0.21 — so the expected value
     * was wrong while the code was right. Reading the actual input level first
     * and asking our own maths what to expect at THAT level tests the thing
     * that matters: that the binary and the preview compute the same curve.
     */
    const [plainR] = await centreColour({ ...NEUTRAL, saturation: 0 })
    const level = plainR / 255
    const expected = applyCurves({ master: LIFT, r: LIFT }, [level, level, level])[0] * 255

    const [r] = await centreColour({ ...NEUTRAL, saturation: 0, curves: { master: LIFT, r: LIFT } })
    expect(Math.abs(r - expected), `expected ~${expected.toFixed(0)}, got ${r}`).toBeLessThan(10)
    // And the curve genuinely lifted it, or the comparison proves nothing.
    expect(r).toBeGreaterThan(plainR + 20)
  }, 120_000)

  it('touches only the channel it was given', async () => {
    const [r, , b] = await centreColour({ ...NEUTRAL, saturation: 0, curves: { r: LIFT } })
    expect(r).toBeGreaterThan(b + 40)
  }, 120_000)
})

describe('grading', () => {
  it('leaves a neutral clip alone, and emits no filter for it', () => {
    const plan = buildRenderPlan({ project: gradedProject(NEUTRAL), outputPath: '/tmp/x.mp4' })
    const graph = plan.args.join(' ')
    // Every filter is paid for on every frame; a no-op grade should cost nothing.
    expect(graph).not.toContain('eq=')
    expect(graph).not.toContain('lut3d')
  })

  it('renders red as red without a grade', async () => {
    const [r, , b] = await centreColour(NEUTRAL)
    expect(r).toBeGreaterThan(180)
    expect(b).toBeLessThan(70)
  }, 120_000)

  it('desaturates when saturation is zero', async () => {
    const [r, g, b] = await centreColour({ ...NEUTRAL, saturation: 0 })
    // Grey: the channels converge.
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20)
  }, 120_000)

  it('brightens', async () => {
    const plain = await centreColour(NEUTRAL)
    const lifted = await centreColour({ ...NEUTRAL, brightness: 0.4 })
    expect(sum(lifted)).toBeGreaterThan(sum(plain))
  }, 120_000)

  describe('LUTs', () => {
    it('applies a .cube at full strength', async () => {
      // The swap LUT turns red into blue. If the axis order were wrong this
      // would come back some other colour entirely.
      const [r, , b] = await centreColour({
        ...NEUTRAL,
        lut: { file: swapLut, intensity: 1 }
      })
      expect(b).toBeGreaterThan(150)
      expect(r).toBeLessThan(80)
    }, 120_000)

    it('blends at partial intensity, rather than being all or nothing', async () => {
      /*
       * lut3d has no mix option — checked against the binary, not assumed — so
       * intensity is a split and a blend. Half strength of a red-to-blue swap is
       * purple: both channels present.
       */
      const [r, , b] = await centreColour({
        ...NEUTRAL,
        lut: { file: swapLut, intensity: 0.5 }
      })
      expect(r).toBeGreaterThan(60)
      expect(b).toBeGreaterThan(60)
    }, 120_000)

    it('does nothing at zero intensity', async () => {
      const [r, , b] = await centreColour({ ...NEUTRAL, lut: { file: swapLut, intensity: 0 } })
      expect(r).toBeGreaterThan(180)
      expect(b).toBeLessThan(70)
    }, 120_000)

    it('still applies the sliders underneath the look', async () => {
      // Order matters: correct the picture, then put the look on it.
      const [r, g, b] = await centreColour({
        ...NEUTRAL,
        saturation: 0,
        lut: { file: swapLut, intensity: 1 }
      })
      // Grey in, grey out — the swap cannot colour a neutral pixel.
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(24)
    }, 120_000)
  })
})

function sum([r, g, b]: [number, number, number]): number {
  return r + g + b
}
