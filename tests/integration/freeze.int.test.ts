import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, freezeFrame, sourceFrameFor, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, writeNote } from './output'

/*
 * A freeze, rendered and read back frame by frame (docs/PLAN.md §5.5).
 *
 * A numbered source — every frame a flat grey of N×4, lossless — split into
 * the three clips at frame 30 with a 15-frame hold: frames 0–29 read 0–29,
 * frames 30–44 all read 30, frame 45 reads 31 (the resume, on the NEXT frame),
 * and the preview's seek agrees with every one. The hold decodes one frame and
 * holds it with the tpad a drawn caption uses; the trim to its first frame is
 * the new part, since one frame of `-t` can decode two.
 */

const fps = 30
const size = 64
let dir = ''
let source = ''

beforeAll(async () => {
  dir = await outputDir('freeze')
  source = join(dir, 'numbered.mp4')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:r=${fps}:d=3`,
    '-vf', "format=yuv420p,geq=lum='min(255,N*4)':cb=128:cr=128",
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', source
  ])
}, 120_000)

/** Every frame of a file, each as the mean of its Y plane — one decode, in order. */
async function frames(file: string): Promise<number[]> {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const buf = stdout as unknown as Buffer
  const frameBytes = (size * size * 3) / 2
  const out: number[] = []
  for (let off = 0; off + frameBytes <= buf.length; off += frameBytes) {
    let total = 0
    for (let i = 0; i < size * size; i++) total += buf[off + i]
    out.push(total / (size * size))
  }
  return out
}

describe('a freeze', () => {
  it('shows the shot to the frame, holds it, and resumes on the next one — the preview seeking to the same frames', async () => {
    const asset: MediaAsset = { id: 'v', path: source, name: 'numbered.mp4', kind: 'video', durationFrames: 3 * fps, width: size, height: size, fps, hasVideo: true, hasAudio: false, size: 1 }
    const clip: Clip = {
      id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
    }
    const empty = emptyProject()
    const plain: Project = { ...empty, settings: { ...empty.settings, width: size, height: size, fps }, assets: [asset], clips: [clip] }
    const frozen = freezeFrame(plain, 'c', 30, 15)!
    const out = join(dir, 'frozen.mp4')
    await run(FFMPEG, buildRenderPlan({ project: frozen, outputPath: out }).args, { maxBuffer: 32 * 1024 * 1024 })

    const read = (await frames(out)).map((y) => Math.round(y / 4))
    const preview = (f: number): number => {
      const c = frozen.clips.find((x) => f >= x.start && f < x.start + x.duration)!
      return sourceFrameFor(c, f)
    }
    const want = (f: number): number => (f < 30 ? f : f < 45 ? 30 : f - 14)
    const lines = ['# freeze', '', 'A numbered source (grey = frame × 4) frozen at frame 30 for 15 frames.', '', `- ${read.length} frames out (the clip was 60; the freeze adds 14)`]
    for (const f of [0, 15, 29, 30, 37, 44, 45, 50, 73]) lines.push(`- frame ${f}: shows source frame ${read[f]}, the preview seeks to ${preview(f)}, want ${want(f)}`)
    await writeNote(dir, lines)

    expect(read.length).toBe(74)
    for (let f = 0; f < 74; f++) {
      expect(read[f], `frame ${f}`).toBe(want(f))
      expect(preview(f), `the preview at frame ${f}`).toBe(want(f))
    }
  }, 300_000)

  it('holds ONE frame of a 60 fps clip in a 30 fps edit — one project frame of it decodes two', async () => {
    const fast = join(dir, 'numbered60.mp4')
    // 60 fps, grey = frame × 2 (120 frames stay under 256).
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:r=60:d=2`, '-vf', "format=yuv420p,geq=lum='min(255,N*2)':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', fast])
    const asset: MediaAsset = { id: 'v', path: fast, name: 'numbered60.mp4', kind: 'video', durationFrames: 2 * fps, width: size, height: size, fps: 60, hasVideo: true, hasAudio: false, size: 1 }
    const clip: Clip = {
      id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 40, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
    }
    const empty = emptyProject()
    const plain: Project = { ...empty, settings: { ...empty.settings, width: size, height: size, fps }, assets: [asset], clips: [clip] }
    const frozen = freezeFrame(plain, 'c', 20, 10)!
    const out = join(dir, 'frozen60.mp4')
    await run(FFMPEG, buildRenderPlan({ project: frozen, outputPath: out }).args, { maxBuffer: 32 * 1024 * 1024 })
    // Project frame 20 is one second in: 60 fps frame 40, grey 80. Every held frame is that one.
    const held = (await frames(out)).slice(20, 30).map((y) => Math.round(y / 2))
    await writeNote(dir, [`- 60 fps clip, held at project frame 20 for 10: the held frames show 60 fps frames ${held.join(', ')} (want 40 each)`])
    for (const [k, f] of held.entries()) expect(f, `held frame ${k}`).toBe(40)
  }, 300_000)
})
