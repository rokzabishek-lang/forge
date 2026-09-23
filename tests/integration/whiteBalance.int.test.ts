import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { whiteBalanceGains } from '@shared/render/whiteBalance'
import { emptyProject, type Clip, type ColorAdjust, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, makeColour, pixelAt, saveFrame, writeNote } from './output'

/*
 * White balance, rendered: the export does what the preview's shader does.
 *
 * The shader multiplies each pixel's RGB by `whiteBalanceGains`. So a grey
 * rendered with a balance must come out as the NEUTRAL render's grey times those
 * same three gains — within the rounding of the yuv420p round trip. That is the
 * parity claim, measured, and a grey stays as bright as it was.
 */

const W = 160
const H = 120
let dir = ''
let grey = ''

beforeAll(async () => {
  dir = await outputDir('white-balance')
  grey = await makeColour(join(dir, 'source-grey.mp4'), '0x808080', { width: W, height: H }, 1, 30)
  await writeNote(dir, [
    'A mid-grey clip, rendered neutral, warm (+1), cool (-1), magenta (+1 tint), green (-1 tint).',
    'Each should be the neutral grey times whiteBalanceGains — what the preview multiplies by.'
  ])
}, 120_000)

function project(color: ColorAdjust): Project {
  const asset: MediaAsset = {
    id: 'g', path: grey, name: 'grey', kind: 'video', durationFrames: 30,
    width: W, height: H, fps: 30, hasVideo: true, hasAudio: false, size: 1
  }
  const clip: Clip = {
    id: 'c', assetId: 'g', trackId: 'v1', start: 0, duration: 15, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color
  }
  return { ...emptyProject(), settings: { ...emptyProject().settings, width: W, height: H, fps: 30 }, assets: [asset], clips: [clip] }
}

async function centre(color: ColorAdjust, name: string): Promise<[number, number, number]> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: project(color), outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0.2, join(dir, `${name}.png`))
  return pixelAt(file, 0.2, W / 2, H / 2, { width: W, height: H })
}

const neutral: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 }
const luma = ([r, g, b]: number[]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

describe('white balance, rendered', () => {
  it('comes out as the neutral picture times the preview’s gains', async () => {
    const base = await centre(neutral, 'neutral')
    for (const [name, temperature, tint] of [['warm', 1, 0], ['cool', -1, 0], ['magenta', 0, 1], ['green', 0, -1]] as const) {
      const got = await centre({ ...neutral, temperature, tint }, name)
      const gains = whiteBalanceGains(temperature, tint)
      const want = [base[0] * gains.r, base[1] * gains.g, base[2] * gains.b]
      for (let c = 0; c < 3; c++) {
        // 4:2:0 chroma and two colour-space conversions: a few levels either way.
        expect(Math.abs(got[c] - want[c]), `${name} channel ${'rgb'[c]}: got ${got[c]}, want ${want[c].toFixed(1)}`).toBeLessThanOrEqual(5)
      }
      // And the grey is as bright as it was.
      expect(Math.abs(luma(got) - luma(base)), `${name} brightness`).toBeLessThanOrEqual(3)
    }
  }, 300_000)

  it('moves the picture the way it says: warm is redder, cool bluer', async () => {
    const warm = await centre({ ...neutral, temperature: 1 }, 'warm-check')
    const cool = await centre({ ...neutral, temperature: -1 }, 'cool-check')
    expect(warm[0]).toBeGreaterThan(warm[2] + 30)
    expect(cool[2]).toBeGreaterThan(cool[0] + 30)
  }, 300_000)
})
