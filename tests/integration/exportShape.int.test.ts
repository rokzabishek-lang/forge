import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { buildRenderPlan, type RenderRequest } from '@shared/render/plan'
import { AUDIO_KBPS, DEFAULT_ENCODE, type EncodeSpec } from '@shared/render/encode'
import { exportCanvas } from '@shared/render/exportShape'
import { probeEncoders, type EncoderAvailability } from '../../src/main/render/encoders'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import {
  FFMPEG, run, outputDir, makeClipWithTone, meanVolumeDb, pixelAt, saveFrame, writeNote
} from './output'

/*
 * B2 rendered: what the export's new shape actually produces.
 *
 * The strings are checked in exportB2.test.ts. This is the claim itself — a
 * range IS that slice of the edit, a codec IS that codec in that container, a
 * bitrate IS about that bitrate — measured on files, which are kept in
 * tests/output/export-shape/ with a README.
 *
 * Encoders are taken from the same probe the app runs. The Windows build is a
 * different binary and may lack x265 or ProRes; a codec this machine cannot
 * make is skipped here exactly as the app would not offer it.
 */

const W = 320
const H = 240
const FPS = 30
let dir = ''
const sources: Record<string, string> = {}
let available: EncoderAvailability[] = []

beforeAll(async () => {
  dir = await outputDir('export-shape')
  // Three shots, one colour and one tone each, so every second of a range
  // can be told apart by picture AND by sound.
  sources.red = await makeClipWithTone(join(dir, 'source-red.mp4'), 'red', 300, { width: W, height: H }, 1, FPS)
  sources.green = await makeClipWithTone(join(dir, 'source-green.mp4'), 'green', 600, { width: W, height: H }, 1, FPS)
  sources.blue = await makeClipWithTone(join(dir, 'source-blue.mp4'), 'blue', 900, { width: W, height: H }, 1, FPS)
  /*
   * A picture and a sound with a lot in them, so a bitrate is a real limit.
   *
   * A clean test pattern at 320x240 needs well under 1 Mbps even at CRF 14,
   * so a 2 Mbps cap never bound; and a sine is so simple that AAC spends 74k
   * on it however many are offered. Moving noise at 720p, and noise in the
   * sound, spend whatever they are given.
   */
  sources.busy = join(dir, 'source-busy.mp4')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}:duration=3`,
    '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.3:duration=3:sample_rate=48000',
    '-vf', 'noise=alls=40:allf=t',
    '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k',
    '-shortest', sources.busy
  ])
  available = await probeEncoders()
  await writeNote(dir, [
    'B2 — the export has a shape, rendered and measured.',
    '',
    'full.mp4          red | green | blue, one second each',
    'range.mp4         frames [20, 70) of it: should open on red, pass green, end on blue',
    'range-*.png       its first, middle and last frames',
    'codec-*.mov/.mp4  one render per encoder this machine can run',
    'bitrate-2m.mp4    the busy source at 2 Mbps; crf-14.mp4 the same at CRF 14',
    'size-4k.mp4       a 16:9 export at 4K',
    '',
    `Encoders found working here: ${available.filter((e) => e.ok).map((e) => e.id).join(', ')}`
  ])
}, 300_000)

function asset(id: string, path: string): MediaAsset {
  return {
    id, path, name: id, kind: 'video', durationFrames: 3 * FPS,
    width: W, height: H, fps: FPS, hasVideo: true, hasAudio: true, size: 1
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'red', trackId: 'v1', start: 0, duration: FPS, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(clips: Clip[]): Project {
  const empty = emptyProject()
  const { loudness: _off, ...settings } = empty.settings
  return {
    ...empty,
    settings: { ...settings, width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: Object.entries(sources).map(([id, path]) => asset(id, path)),
    clips
  }
}

const threeShots = (): Project =>
  project([
    clip({ id: 'r', assetId: 'red', start: 0 }),
    clip({ id: 'g', assetId: 'green', start: FPS }),
    clip({ id: 'b', assetId: 'blue', start: 2 * FPS })
  ])

async function render(request: Omit<RenderRequest, 'outputPath'>, name: string): Promise<string> {
  const file = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ ...request, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  return file
}

/** ffmpeg's own description of a file's streams and container. */
async function describe_(file: string): Promise<string> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file]).catch((e: { stderr: string }) => e)
  return stderr
}

async function durationSeconds(file: string): Promise<number> {
  const found = /Duration: (\d+):(\d+):([\d.]+)/.exec(await describe_(file))
  if (!found) throw new Error(`no duration for ${file}`)
  return Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])
}

const isRed = ([r, g, b]: number[]): boolean => r > 150 && g < 90 && b < 90
const isGreen = ([r, g, b]: number[]): boolean => g > 90 && r < 90 && b < 90
const isBlue = ([r, g, b]: number[]): boolean => b > 150 && r < 90 && g < 90

describe('a range export, rendered', () => {
  it('is exactly that slice of the edit — picture, sound and length', async () => {
    const full = await render({ project: threeShots() }, 'full.mp4')
    const range = await render({ project: threeShots(), range: { start: 20, end: 70 } }, 'range.mp4')

    // 50 frames at 30 fps. AAC rounds up to its own frame, so allow one.
    expect(Math.abs((await durationSeconds(range)) - 50 / FPS)).toBeLessThan(0.05)

    // Opens on red (full frame 20), passes green (35), ends on blue (65).
    const at = (file: string, frame: number): Promise<[number, number, number]> =>
      pixelAt(file, frame / FPS, W / 2, H / 2, { width: W, height: H })
    expect(isRed(await at(range, 1))).toBe(true)
    expect(isGreen(await at(range, 15))).toBe(true)
    expect(isBlue(await at(range, 45))).toBe(true)
    await saveFrame(range, 1 / FPS, join(dir, 'range-first.png'))
    await saveFrame(range, 15 / FPS, join(dir, 'range-middle.png'))
    await saveFrame(range, 45 / FPS, join(dir, 'range-last.png'))

    // The sound is the same sound at the same moment: the green second of the
    // range is the green second of the full render, to within a dB.
    const rangeGreen = await meanVolumeDb(range, 12 / FPS, 0.6)
    const fullGreen = await meanVolumeDb(full, 32 / FPS, 0.6)
    expect(Math.abs(rangeGreen - fullGreen)).toBeLessThan(1)
  }, 300_000)

  it('starts cleanly on a clip that began before the in point, after a transition', async () => {
    // The green shot dissolves in over red; the range starts after the
    // dissolve, so red is dropped entirely and green must still render.
    const p = project([
      clip({ id: 'r', assetId: 'red', start: 0 }),
      clip({ id: 'g', assetId: 'green', start: 20, duration: 40, transitionIn: { id: 'dissolve', durationFrames: 10 } }),
      clip({ id: 'b', assetId: 'blue', start: 60 })
    ])
    const range = await render({ project: p, range: { start: 35, end: 75 } }, 'range-after-dissolve.mp4')
    expect(isGreen(await pixelAt(range, 2 / FPS, W / 2, H / 2, { width: W, height: H }))).toBe(true)
    expect(isBlue(await pixelAt(range, 35 / FPS, W / 2, H / 2, { width: W, height: H }))).toBe(true)
  }, 300_000)
})

describe('codecs, rendered', () => {
  const cases: { encoder: EncodeSpec['encoder']; container: 'mp4' | 'mov'; codec: RegExp; extra?: RegExp }[] = [
    { encoder: 'libx264', container: 'mp4', codec: /Video: h264/ },
    { encoder: 'libx264', container: 'mov', codec: /Video: h264/ },
    { encoder: 'libx265', container: 'mp4', codec: /Video: hevc/, extra: /hvc1/ },
    { encoder: 'prores_ks', container: 'mov', codec: /Video: prores \(HQ\)/, extra: /yuv422p10le/ }
  ]
  for (const c of cases) {
    it(`${c.encoder} in .${c.container}`, async (ctx) => {
      if (!available.some((a) => a.id === c.encoder && a.ok)) ctx.skip()
      const file = await render(
        { project: threeShots(), encode: { ...DEFAULT_ENCODE, encoder: c.encoder, container: c.container } },
        `codec-${c.encoder}.${c.container}`
      )
      const info = await describe_(file)
      expect(info).toMatch(c.codec)
      if (c.extra) expect(info).toMatch(c.extra)
      // The container is the one asked for, whatever the extension would pick.
      expect(info).toMatch(c.container === 'mov' ? /major_brand\s*:\s*qt/ : /major_brand\s*:\s*isom/)
      expect(info).toMatch(/Audio: aac/)
    }, 300_000)
  }

  it('puts ProRes in QuickTime even when the name says .mp4', async (ctx) => {
    if (!available.some((a) => a.id === 'prores_ks' && a.ok)) ctx.skip()
    const file = await render(
      { project: threeShots(), encode: { ...DEFAULT_ENCODE, encoder: 'prores_ks', container: 'mp4' } },
      'codec-prores-named-mp4.mp4'
    )
    expect(await describe_(file)).toMatch(/major_brand\s*:\s*qt/)
  }, 300_000)
})

describe('quality, rendered', () => {
  const busy = (): Project => project([clip({ id: 'x', assetId: 'busy', duration: 3 * FPS })])
  const hd = { width: 1280, height: 720 }

  it('a bitrate target is about that bitrate, and a CRF is not bound by it', async () => {
    const target = await render(
      { project: busy(), canvas: hd, encode: { ...DEFAULT_ENCODE, quality: { mode: 'bitrate', kbps: 2000 } } },
      'bitrate-2m.mp4'
    )
    const crf = await render(
      { project: busy(), canvas: hd, encode: { ...DEFAULT_ENCODE, quality: { mode: 'crf', crf: 14 } } },
      'crf-14.mp4'
    )
    const kbps = async (file: string): Promise<number> => ((await stat(file)).size * 8) / 1000 / 3
    const measured = await kbps(target)
    // Picture at the cap, plus 192k of sound and the container: about 2.2 Mbps.
    expect(measured).toBeLessThan(2000 * 1.3)
    expect(measured).toBeGreaterThan(2000 * 0.7)
    // And the mode matters: the same picture at CRF 14 is nowhere near held to it.
    expect(await kbps(crf)).toBeGreaterThan(measured * 2)
  }, 300_000)

  it('the audio bitrate is the one asked for', async () => {
    const audioKbps = async (kbps: number): Promise<number> => {
      const file = await render({ project: busy(), encode: { ...DEFAULT_ENCODE, audioKbps: kbps } }, `audio-${kbps}.mp4`)
      const found = /Audio: aac.*?(\d+) kb\/s/.exec(await describe_(file))
      return Number(found?.[1])
    }
    // Every step offered comes out near its label, and above the one below —
    // which is the whole claim a list of bitrates makes.
    const measured: number[] = []
    for (const kbps of AUDIO_KBPS) {
      const got = await audioKbps(kbps)
      expect(Math.abs(got - kbps) / kbps, `${kbps}k came out ${got}k`).toBeLessThan(0.15)
      if (measured.length > 0) expect(got).toBeGreaterThan(measured[measured.length - 1])
      measured.push(got)
    }
    /*
     * And the one NOT offered. This encoder writes LESS at 320k than at 256k
     * (measured 248 against 260), which is why 320 is not on the list; a
     * preset that stored it renders at 256 rather than at a worse number.
     */
    expect(Math.abs((await audioKbps(320)) - 256) / 256).toBeLessThan(0.15)
  }, 300_000)
})

describe('size, rendered', () => {
  it('a 4K export is 3840×2160', async () => {
    const canvas = exportCanvas('16:9', '4k')
    const p = { ...threeShots(), settings: { ...threeShots().settings, width: 1920, height: 1080 } }
    const file = await render({ project: p, canvas, range: { start: 0, end: 10 } }, 'size-4k.mp4')
    expect(await describe_(file)).toMatch(/3840x2160/)
  }, 300_000)
})
