import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { peaksFor } from '../../src/main/waveform'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

let dir = ''
let tone = ''
let silence = ''
let burst = ''
let silentVideo = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-wave-'))
  tone = join(dir, 'tone.wav')
  silence = join(dir, 'silence.wav')
  burst = join(dir, 'burst.wav')
  silentVideo = join(dir, 'novideo.mp4')

  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'volume=6', tone])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3', silence])
  // Quiet, then loud: peaks must reflect that, and averaging would hide it.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100',
    '-af', "volume=volume='if(lt(t,1),0.02,8)':eval=frame", burst])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=10:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('peaksFor', () => {
  it('returns min/max pairs and a duration', async () => {
    const peaks = await peaksFor(tone, 200)
    expect(peaks.buckets).toBeGreaterThan(100)
    expect(peaks.values).toHaveLength(peaks.buckets * 2)
    expect(peaks.durationMs).toBeGreaterThan(2800)
    expect(peaks.durationMs).toBeLessThan(3200)
  }, 120_000)

  it('keeps every value inside -1..1', async () => {
    const peaks = await peaksFor(tone, 200)
    for (const value of peaks.values) {
      expect(value).toBeGreaterThanOrEqual(-1)
      expect(value).toBeLessThanOrEqual(1)
    }
  }, 120_000)

  it('orders each pair as min then max', async () => {
    const peaks = await peaksFor(tone, 200)
    for (let i = 0; i < peaks.buckets; i++) {
      expect(peaks.values[i * 2]).toBeLessThanOrEqual(peaks.values[i * 2 + 1])
    }
  }, 120_000)

  it('reflects a loud signal as a large excursion', async () => {
    const peaks = await peaksFor(tone, 200)
    const loudest = Math.max(...peaks.values.map(Math.abs))
    // Note: ffmpeg's sine filter runs at roughly -18 dB, hence the explicit
    // volume boost on the fixture rather than a higher expectation here.
    expect(loudest).toBeGreaterThan(0.5)
  }, 120_000)

  it('reports silence as flat', async () => {
    const peaks = await peaksFor(silence, 200)
    const loudest = Math.max(...peaks.values.map(Math.abs))
    expect(loudest).toBeLessThan(0.02)
  }, 120_000)

  it('preserves a transient instead of averaging it away', async () => {
    const peaks = await peaksFor(burst, 200)
    const half = Math.floor(peaks.buckets / 2)
    const quiet = Math.max(...peaks.values.slice(0, half).map(Math.abs))
    const loud = Math.max(...peaks.values.slice(half * 2).map(Math.abs))
    // Averaging would flatten this into a uniform band.
    expect(loud).toBeGreaterThan(quiet * 3)
  }, 120_000)

  it('returns an empty waveform for media with no audio, not an error', async () => {
    const peaks = await peaksFor(silentVideo, 200)
    expect(peaks.buckets).toBe(0)
    expect(peaks.values).toEqual([])
  }, 120_000)

  it('caches, so re-selecting a clip is instant', async () => {
    const first = await peaksFor(tone, 256)
    const second = await peaksFor(tone, 256)
    expect(second).toBe(first)
  }, 120_000)
})
