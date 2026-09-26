import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { rampRate, rampSourceAt, sourceFrameAt, withClipRamp } from '@shared/render/speed'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, saveFrame, writeNote } from './output'

/*
 * A speed ramp, rendered and read back frame by frame (docs/PLAN.md §5.5).
 *
 * The source is numbered: every frame a flat grey of N×4, encoded losslessly,
 * so "which source frame is this?" is a number read off the picture — the
 * same probe docs/EFFECTS.md §18 measured the ramp with. It is FOUR seconds
 * long although the ramp plays two: a decode window sized by the output
 * instead of the footage would run on into frames the ramp never meant to show
 * (and past T = D the ramp's own curve goes negative), rather than hitting the
 * end of the file and passing by accident.
 *
 * The oracle is §18's own numbers: 1× → 0.25× over 2 s of source lasts 3.70 s,
 * and at 1, 2 and 3 s shows source frames 25, 42 and 54. And the preview's
 * seek (`sourceFrameAt`) must agree with every frame read.
 */

const fps = 30
const size = 64
let dir = ''
let source = ''

beforeAll(async () => {
  dir = await outputDir('ramp')
  source = join(dir, 'numbered.mp4')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:r=${fps}:d=4`,
    '-vf', "format=yuv420p,geq=lum='min(255,N*4)':cb=128:cr=128",
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', source
  ])
}, 120_000)

/** The mean luma of the frame at `seconds`, read from the Y plane as it is stored. */
async function lumaAt(file: string, seconds: number): Promise<number> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', seconds.toFixed(4), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
  )
  const y = (stdout as unknown as Buffer).subarray(0, size * size)
  let total = 0
  for (const v of y) total += v
  return total / y.length
}

async function durationOf(file: string): Promise<number> {
  const out = await run(FFMPEG, ['-hide_banner', '-i', file]).catch((err: { stderr: string }) => err)
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out.stderr)
  if (!m) throw new Error(`no duration for ${file}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function project(): Project {
  const asset: MediaAsset = {
    id: 'v', path: source, name: 'numbered.mp4', kind: 'video', durationFrames: 4 * fps,
    width: size, height: size, fps, hasVideo: true, hasAudio: false, size: 1
  }
  // Two seconds of footage at normal speed, then ramped 1× → 0.25× the way the app ramps it.
  const clip: Clip = {
    id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 2 * fps, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const empty = emptyProject()
  const plain: Project = { ...empty, settings: { ...empty.settings, width: size, height: size, fps }, assets: [asset], clips: [clip] }
  return withClipRamp(plain, 'c', { from: 1, to: 0.25 })
}

describe('a speed ramp', () => {
  it('lasts what §18 measured, shows the source frames §18 read, and the preview seeks to the same frames', async () => {
    const p = project()
    const clip = p.clips[0]
    const out = join(dir, 'ramped.mp4')
    await run(FFMPEG, buildRenderPlan({ project: p, outputPath: out }).args, { maxBuffer: 32 * 1024 * 1024 })

    const seconds = await durationOf(out)
    const lines = ['# ramp', '', `2 s of numbered footage (grey = frame × 4) ramped 1× → 0.25×: ${clip.duration} frames on the timeline.`, '',
      `- length ${seconds.toFixed(3)} s (the clip ${(clip.duration / fps).toFixed(3)} s; §18 measured 3.70 s for exactly 2 s of footage)`]
    const samples: { t: number; read: number; preview: number; want: number }[] = []
    for (const [t, want] of [[1, 25], [2, 42], [3, 54]] as const) {
      const read = (await lumaAt(out, t + 0.5 / fps)) / 4
      const preview = sourceFrameAt(clip, Math.floor(t * fps))
      samples.push({ t, read, preview, want })
      await saveFrame(out, t, join(dir, `at-${t}s.png`))
      lines.push(`- at ${t} s: the picture is source frame ${read.toFixed(1)}; the preview seeks to ${preview}; §18 read ${want}`)
    }
    lines.push('', `The curve predicts ${[1, 2, 3].map((t) => rampSourceAt(1, 0.25, clip.duration * rampRate(1, 0.25), t * fps).toFixed(1)).join(', ')}.`)
    await writeNote(dir, lines)

    expect(Math.abs(seconds - 3.7)).toBeLessThan(0.05)
    for (const { t, read, preview, want } of samples) {
      expect(Math.abs(read - want), `the picture at ${t} s`).toBeLessThanOrEqual(1)
      expect(Math.abs(preview - read), `the preview at ${t} s`).toBeLessThanOrEqual(1)
    }
  }, 300_000)

  it('does not play the clip’s own sound — atempo cannot follow a curve — while a plain clip’s plays', () => {
    const p = project()
    const talking = { ...p, assets: p.assets.map((a) => ({ ...a, hasAudio: true })) }
    const graph = (proj: Project): string => {
      const args = buildRenderPlan({ project: proj, outputPath: join(dir, 'x.mp4') }).args
      return args[args.indexOf('-filter_complex') + 1]
    }
    expect(graph(talking)).not.toContain('[va0]')
    const plain = { ...talking, clips: talking.clips.map(({ ramp: _r, ...c }) => ({ ...c, duration: 2 * fps })) }
    expect(graph(plain)).toContain('[va0]')
  })
})
