import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { concatList, planCaptionBake } from '@shared/captions/bake'
import { captionSpec } from '@shared/captions/line'
import { styleById } from '@shared/captions/style'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { CaptionLayer } from '@shared/graphics/spec'
import type { Word } from '@shared/transcript'

/*
 * Styled captions, composited in the single pass.
 *
 * The old path rendered the whole video to a temporary file, screenshotted an
 * offscreen browser once per frame, then decoded and re-encoded the video with
 * those frames on top. This replaces all of it with one more input to the graph
 * that already exists: a handful of baked pictures, replayed by the concat
 * demuxer, overlaid on the BAND of the frame the captions occupy.
 *
 * Three things can go wrong and none of them show up in the filter string — the
 * band can land at the wrong height, the timing can drift because the demuxer
 * drops the last duration, and the alpha can be lost so the band paints a solid
 * slab over the picture. So this renders real pixels and looks at them.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 320
const H = 240
const FPS = 10
const DURATION = 40
/** Where the caption band sits — deliberately not the middle of the frame. */
const BAND_Y = 160
const BAND_H = 60

let dir = ''
let listPath = ''
let source = ''

/** Mean luminance of a small patch. */
async function patch(file: string, at: number, x: number, y: number): Promise<number> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', file,
     '-frames:v', '1', '-vf', `crop=16:16:${x}:${y}`,
     '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
  )
  const buffer = stdout as unknown as Buffer
  let total = 0
  for (const v of buffer) total += v
  return total / buffer.length
}

function words(list: [string, number, number][]): Word[] {
  return list.map(([text, startMs, endMs], index) => ({
    index, text, startMs, endMs, confidence: 1
  }))
}

/** Two lines: white for the first, then dark grey, so "which" is measurable. */
const LAYERS: CaptionLayer[] = [
  {
    id: 'l1', kind: 'caption', startFrame: 0, endFrame: 20,
    spec: captionSpec(styleById('pop'), words([['one', 0, 2000]]), -1),
    wordFrames: [0]
  },
  {
    id: 'l2', kind: 'caption', startFrame: 20, endFrame: 40,
    spec: captionSpec(styleById('pop'), words([['two', 2000, 4000]]), -1),
    wordFrames: [20]
  }
]

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-capoverlay-'))
  source = join(dir, 'src.png')

  // A black frame to lay captions over, so anything lit is the caption.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:size=${W}x${H}:rate=1:duration=1`,
    '-frames:v', '1', source])

  const plan = planCaptionBake(LAYERS, FPS, DURATION)!

  /*
   * Stand-ins for what the renderer paints: a band-sized picture, transparent
   * except for a bar whose brightness says which picture it is. The point under
   * test is the plumbing — band placement, timing and alpha — not the type.
   *
   * Built by overlaying an opaque bar onto a transparent canvas, NOT by drawbox:
   * drawbox writes colour and leaves alpha alone, so on a transparent base it
   * produces a white bar at alpha 0 — invisible, and indistinguishable from the
   * overlay not working. That cost a debugging round; a canvas, which is what
   * actually paints these, writes both.
   */
  const files: string[] = []
  for (const [index, picture] of plan.pictures.entries()) {
    const file = join(dir, `p${index}.png`)
    const shade = picture.layer < 0 ? null : picture.layer === 0 ? 'white' : '0x555555'
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black@0:size=${W}x${BAND_H},format=rgba`,
      ...(shade ? ['-f', 'lavfi', '-i', `color=${shade}:size=240x40,format=rgba`] : []),
      ...(shade ? ['-filter_complex', '[0][1]overlay=40:10:format=auto'] : []),
      '-frames:v', '1', file])
    files.push(file)
  }

  listPath = join(dir, 'captions.txt')
  await writeFile(listPath, concatList(plan, FPS, (p) => files[p]), 'utf8')
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function project(): Project {
  const asset: MediaAsset = {
    id: 'bg', path: source, name: 'bg', kind: 'image', durationFrames: DURATION,
    width: W, height: H, fps: FPS, hasVideo: true, hasAudio: false, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'bg', trackId: 'v1', start: 0, duration: DURATION, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

describe('a baked caption overlay', () => {
  let out = ''

  beforeAll(async () => {
    out = join(dir, 'captioned.mp4')
    const plan = buildRenderPlan({
      project: project(),
      outputPath: out,
      captionOverlay: { listPath, y: BAND_Y, height: BAND_H }
    })
    await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })
  }, 180_000)

  it('lands the band where it was told to, and nowhere else', async () => {
    // Inside the band: the bar. Above it: untouched black. Getting the offset
    // wrong is the failure that looks like "the captions moved".
    expect(await patch(out, 0.2, 150, BAND_Y + 20)).toBeGreaterThan(200)
    expect(await patch(out, 0.2, 150, 40)).toBeLessThan(20)
  })

  it('keeps its alpha, rather than painting a slab', async () => {
    // Transparent parts of the band must leave the picture underneath alone. A
    // lost alpha channel shows up here as a lit box the width of the frame.
    expect(await patch(out, 0.2, 8, BAND_Y + 20)).toBeLessThan(20)
  })

  it('changes picture when the line does', async () => {
    // Frame 20 of 40 at 10fps: the second line, drawn darker.
    const first = await patch(out, 0.2, 150, BAND_Y + 20)
    const second = await patch(out, 2.2, 150, BAND_Y + 20)
    expect(first).toBeGreaterThan(200)
    expect(second).toBeGreaterThan(50)
    expect(second).toBeLessThan(150)
  })

  it('holds the last run instead of dropping it', async () => {
    /*
     * The concat demuxer ignores the final `duration`, so without repeating the
     * last entry the closing run vanishes — and the closing run is usually the
     * longest. Sampled near the very end.
     */
    expect(await patch(out, 3.8, 150, BAND_Y + 20)).toBeGreaterThan(50)
  })

  it('renders in one pass, with the captions as one more input', () => {
    const plan = buildRenderPlan({
      project: project(),
      outputPath: '/tmp/x.mp4',
      captionOverlay: { listPath, y: BAND_Y, height: BAND_H }
    })
    const args = plan.args.join(' ')
    expect(args).toContain('-f concat')
    expect(args).toContain(`overlay=0:${BAND_Y}`)
    // One encode. A second output file would mean the two-pass path is back.
    expect(plan.args.filter((a) => a.endsWith('.mp4'))).toHaveLength(1)
  })

  it('leaves a project without captions completely alone', () => {
    const args = buildRenderPlan({ project: project(), outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(args).not.toContain('-f concat')
    expect(args).not.toContain('[cap]')
  })
})
