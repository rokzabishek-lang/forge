import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Two exports, two very different sources, one level.
 *
 * This is the whole feature stated as a test. The complaint it answers is
 * "two exports can land at different levels", so the assertion is not that a
 * filter was emitted — it is that a quiet source and a loud source, rendered
 * separately, come out within a decibel of each other.
 *
 * Runs on Windows CI too, which is where `loudnorm` has to hold up: it merged
 * in 3.1 (2016), comfortably before the 2018-12-17 snapshot, but "comfortably
 * before" is a prediction until a runner has done it.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FPS = 30
const SECONDS = 6
const TARGET = -14

let dir = ''
let quiet = ''
let loud = ''
let picture = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-loud-'))
  quiet = join(dir, 'quiet.wav')
  loud = join(dir, 'loud.wav')
  picture = join(dir, 'grey.png')
  // Twenty-six decibels apart, and different material, so nothing about the
  // result can come from the two being the same file at two gains.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${SECONDS}:sample_rate=48000`,
    '-ac', '2', '-af', 'volume=-20dB', quiet])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
    '-i', `anoisesrc=d=${SECONDS}:c=pink:a=0.5:r=48000`, '-ac', '2', '-af', 'volume=6dB', loud])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
    '-i', 'color=c=gray:size=160x120:rate=1:duration=1', '-frames:v', '1', picture])
}, 240_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function project(audioPath: string, loudness: number | undefined): Project {
  const still: MediaAsset = {
    id: 'p', path: picture, name: 'p', kind: 'image', durationFrames: FPS * SECONDS,
    width: 160, height: 120, fps: null, hasVideo: true, hasAudio: false, size: 0
  }
  const sound: MediaAsset = {
    id: 'a', path: audioPath, name: 'a', kind: 'audio', durationFrames: FPS * SECONDS,
    width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 0
  }
  const base = {
    start: 0, duration: FPS * SECONDS, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const settings = { width: 160, height: 120, fps: FPS, sampleRate: 48000 }
  return {
    ...emptyProject(),
    settings: loudness === undefined ? settings : { ...settings, loudness },
    assets: [still, sound],
    clips: [
      { id: 'pic', assetId: 'p', trackId: 'v1', ...base },
      { id: 'snd', assetId: 'a', trackId: 'a1', ...base }
    ]
  }
}

/** Integrated loudness and true peak of a finished file. */
async function measure(file: string): Promise<{ lufs: number; truePeak: number }> {
  const { stderr } = await run(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-i', file, '-af',
     'loudnorm=I=-14:TP=-1:print_format=json', '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 }
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }))
  const text = String(stderr)
  const lufs = /"input_i"\s*:\s*"(-?[\d.inf]+)"/.exec(text)
  const peak = /"input_tp"\s*:\s*"(-?[\d.inf]+)"/.exec(text)
  return { lufs: Number(lufs?.[1]), truePeak: Number(peak?.[1]) }
}

async function render(p: Project, name: string): Promise<string> {
  const out = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: out }).args,
    { maxBuffer: 32 * 1024 * 1024 })
  return out
}

/** The rate the output's audio stream actually carries. */
async function sampleRate(file: string): Promise<number> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file], { maxBuffer: 4 * 1024 * 1024 })
    .catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }))
  const match = /Audio:.*?(\d+) Hz/.exec(String(stderr))
  return match ? Number(match[1]) : Number.NaN
}

describe('loudness normalisation', () => {
  it('lands two very different sources on the same level', async () => {
    const rawQuiet = await render(project(quiet, undefined), 'raw-quiet.mp4')
    const rawLoud = await render(project(loud, undefined), 'raw-loud.mp4')
    const normQuiet = await render(project(quiet, TARGET), 'norm-quiet.mp4')
    const normLoud = await render(project(loud, TARGET), 'norm-loud.mp4')

    const before = [await measure(rawQuiet), await measure(rawLoud)]
    const after = [await measure(normQuiet), await measure(normLoud)]

    // The control: without it, the two exports really are far apart.
    expect(Math.abs(before[0].lufs - before[1].lufs)).toBeGreaterThan(10)

    // With it, both are on target and therefore on each other.
    for (const result of after) {
      expect(Math.abs(result.lufs - TARGET)).toBeLessThan(1)
    }
    expect(Math.abs(after[0].lufs - after[1].lufs)).toBeLessThan(1)
  }, 300_000)

  it('keeps the true peak under the ceiling', async () => {
    /*
     * Raising a loud source to target is the case that clips. A file mastered
     * to full scale overshoots once it is AAC, so the ceiling is a decibel
     * down and the output must respect it.
     */
    const out = await render(project(loud, TARGET), 'peak.mp4')
    const { truePeak } = await measure(out)
    expect(truePeak).toBeLessThan(-0.5)
  }, 300_000)

  it('does not leave the export at 192 kHz', async () => {
    /*
     * `loudnorm` resamples internally and emits 192 kHz whatever went in. The
     * `aformat` after it is the only thing putting that back, and nothing
     * about the sound would reveal the difference — the file would simply be
     * four times the samples and disagree with `settings.sampleRate`.
     */
    const out = await render(project(quiet, TARGET), 'rate.mp4')
    expect(await sampleRate(out)).toBe(48000)
  }, 300_000)

  it('renders a project with no audio at all', async () => {
    /*
     * The silence branch. `loudnorm` measures silence at -inf LUFS, so this
     * has to stay off it — and "the render still completes" is the assertion,
     * because the failure mode is a dead export rather than a wrong level.
     */
    const silent = project(quiet, TARGET)
    const noSound: Project = { ...silent, clips: silent.clips.filter((c) => c.id === 'pic') }
    const out = await render(noSound, 'silent.mp4')
    expect(await sampleRate(out)).toBe(48000)
  }, 300_000)
})
