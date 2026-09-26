import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, writeNote } from './output'

/*
 * Every clip lands on its own frames — found while building the freeze.
 *
 * A clip was drawn only while `between(t, start, end)`, the times written to
 * six places, and moved into place by `setpts=…+start/TB`, which TRUNCATES.
 * 20 frames at 30 fps is 0.6666667 s, written 0.666667: frame 20 fell a hair
 * before its own clip's window and was not drawn — black. 10 frames is
 * 0.333333 s, 9.99999 ticks, truncated to 9: the whole clip landed a frame
 * early, and its first frame was hidden. Only starts on exact times — whole
 * seconds — were right, so most cuts in an ordinary edit were a frame out.
 *
 * Back-to-back clips of a numbered source (grey = frame × 4, lossless) at
 * awkward starts, every output frame read back against the source frame it
 * must show; and a 60 fps clip in the 30 fps edit, one project frame of which
 * is two of its own.
 */

const fps = 30
const size = 64
let dir = ''
let source = ''
let source60 = ''

async function numbered(file: string, rate: number, seconds: number, step: number): Promise<string> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:r=${rate}:d=${seconds}`, '-vf', `format=yuv420p,geq=lum='min(255,N*${step})':cb=128:cr=128`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', file])
  return file
}

/** Every frame of a file, each as the mean of its Y plane. */
async function frames(file: string): Promise<number[]> {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const buf = stdout as unknown as Buffer
  const bytes = (size * size * 3) / 2
  const out: number[] = []
  for (let off = 0; off + bytes <= buf.length; off += bytes) {
    let total = 0
    for (let i = 0; i < size * size; i++) total += buf[off + i]
    out.push(total / (size * size))
  }
  return out
}

const clip = (id: string, asset: string, start: number, duration: number, inPoint: number): Clip => ({
  id, assetId: asset, trackId: 'v1', start, duration, inPoint, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
})

function project(clips: Clip[]): Project {
  const asset = (id: string, path: string, rate: number): MediaAsset => ({ id, path, name: id, kind: 'video', durationFrames: 3 * fps, width: size, height: size, fps: rate, hasVideo: true, hasAudio: false, size: 1 })
  const empty = emptyProject()
  return { ...empty, settings: { ...empty.settings, width: size, height: size, fps }, assets: [asset('n30', source, 30), asset('n60', source60, 60)], clips }
}

beforeAll(async () => {
  dir = await outputDir('placement')
  source = await numbered(join(dir, 'numbered30.mp4'), 30, 3, 4)
  source60 = await numbered(join(dir, 'numbered60.mp4'), 60, 3, 1)
}, 120_000)

describe('every clip lands on its own frames', () => {
  it('back-to-back clips at starts that round up and down all show exactly the frames they should', async () => {
    // Starts 0, 5, 11, 20, 25 — 0.166667 and 0.366667 and 0.666667 round up, 0.833333 down.
    const cuts: [number, number, number][] = [[0, 5, 0], [5, 6, 40], [11, 9, 10], [20, 5, 50], [25, 8, 20]]
    const p = project(cuts.map(([start, duration, inPoint], k) => clip(`c${k}`, 'n30', start, duration, inPoint)))
    const out = join(dir, 'cuts.mp4')
    await run(FFMPEG, buildRenderPlan({ project: p, outputPath: out }).args, { maxBuffer: 32 * 1024 * 1024 })
    const read = (await frames(out)).map((y) => Math.round(y / 4))
    const want = (f: number): number => {
      const [start, , inPoint] = cuts.find(([s, d]) => f >= s && f < s + d)!
      return inPoint + (f - start)
    }
    const lines = ['# placement', '', 'Back-to-back clips of a numbered 30 fps source (grey = frame × 4) at starts 0, 5, 11, 20, 25.', '']
    for (const [start] of cuts) lines.push(`- the cut at frame ${start} (${(start / fps).toFixed(7)} s): shows source frame ${read[start]}, want ${want(start)}; the frame before it ${start > 0 ? read[start - 1] : '—'}`)
    await writeNote(dir, lines)
    expect(read.length).toBe(33)
    for (let f = 0; f < 33; f++) expect(read[f], `frame ${f}`).toBe(want(f))
  }, 300_000)

  it('a 60 fps clip at frame 20 of a 30 fps edit shows its own first frame there, not black', async () => {
    const p = project([clip('c', 'n60', 20, 10, 20)])
    const out = join(dir, 'sixty.mp4')
    await run(FFMPEG, buildRenderPlan({ project: p, outputPath: out }).args, { maxBuffer: 32 * 1024 * 1024 })
    const read = await frames(out)
    // Project frame 20 plays the 60 fps clip from its own frame 40 (grey 40), two of its frames a project frame.
    for (let f = 20; f < 30; f++) expect(Math.round(read[f]), `frame ${f}`).toBe(40 + 2 * (f - 20))
    // Before it, only the black base.
    expect(Math.round(read[19])).toBeLessThanOrEqual(16)
  }, 300_000)
})
