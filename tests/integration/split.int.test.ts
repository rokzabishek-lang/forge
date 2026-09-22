import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, splitClip, trimStart, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, makeColour, makeTone, meanVolumeDb, writeNote } from './output'

/*
 * A split is invisible — rendered, not assumed.
 *
 * `splitClip` now keeps a clip's animation on its own clock: the right half's
 * keyframes are shifted back by the length of the left, which puts some of them
 * at NEGATIVE frames, and the export's volume expression then carries times like
 * `lt(t,-1.5000)`. The arithmetic says that is fine; this asks ffmpeg. A volume
 * ramp is rendered whole, split, and head-trimmed, and the three must sound the
 * same at every point they share.
 */

const W = 320
const H = 240
const FPS = 30
const SECONDS = 4
let dir = ''
let picture = ''
let tone = ''

beforeAll(async () => {
  dir = await outputDir('split')
  picture = await makeColour(join(dir, 'source-picture.mp4'), 'blue', { width: W, height: H }, SECONDS, FPS)
  tone = await makeTone(join(dir, 'source-tone.m4a'), 440, SECONDS)
  await writeNote(dir, [
    'A split and a head trim, heard against the whole clip.',
    '',
    'whole.mp4    a 440Hz tone ramping from full level down to 10% over four seconds',
    'split.mp4    the same, split at 1.5s — the right half carries keys at negative frames',
    'trimmed.mp4  the same with its first second trimmed off (compare from 1s on)',
    '',
    'Before the fix, split.mp4 jumped back to full level at the cut: the right half',
    'replayed the ramp from its own start. Play whole.mp4 and split.mp4 back to back.'
  ])
}, 300_000)

const asset = (id: string, path: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset => ({
  id, path, name: id, kind, durationFrames: SECONDS * FPS,
  width: W, height: H, fps: FPS, hasVideo: kind === 'video', hasAudio, size: 1
})

const ramp: Clip = {
  id: 'tone', assetId: 'tone', trackId: 'a1', start: 0, duration: SECONDS * FPS, inPoint: 0, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 },
  keyframes: { volume: [{ frame: 0, value: 1 }, { frame: SECONDS * FPS, value: 0.1 }] }
}

const project = (sound: Clip[]): Project => ({
  ...emptyProject(),
  settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
  assets: [asset('pic', picture, 'video', false), asset('tone', tone, 'audio', true)],
  clips: [
    {
      id: 'bg', assetId: 'pic', trackId: 'v1', start: 0, duration: SECONDS * FPS, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 }
    },
    ...sound
  ]
})

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  return file
}

/** Level in quarter-second windows from `from` to `to`, in dB. */
async function profile(file: string, from: number, to: number): Promise<number[]> {
  const out: number[] = []
  for (let t = from; t < to - 0.01; t += 0.25) out.push(await meanVolumeDb(file, t, 0.25))
  return out
}

describe('a split is invisible in the render', () => {
  it('sounds the same as the unsplit clip, either side of the cut', async () => {
    const [left, right] = splitClip(ramp, 45)!
    // The whole point: the right half really does carry a key before its start.
    expect(right.keyframes!.volume![0].frame).toBeLessThan(0)

    const whole = await render(project([ramp]), 'whole.mp4')
    const split = await render(project([left, { ...right, id: 'tone-b' }]), 'split.mp4')

    const a = await profile(whole, 0, SECONDS)
    const b = await profile(split, 0, SECONDS)
    // Before the fix the window after the cut came back ~10 dB hot.
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `window ${i}`).toBeLessThan(0.6)
    // And it IS a ramp, or equal levels would prove nothing.
    expect(a[0] - a[a.length - 1]).toBeGreaterThan(12)
  }, 300_000)

  it('keeps the ramp on the picture when the head is trimmed', async () => {
    const trimmed = trimStart(ramp, FPS)
    const whole = await render(project([ramp]), 'whole-for-trim.mp4')
    const cut = await render(project([trimmed]), 'trimmed.mp4')
    const a = await profile(whole, 1, SECONDS)
    const b = await profile(cut, 1, SECONDS)
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `window ${i}`).toBeLessThan(0.6)
  }, 300_000)
})
