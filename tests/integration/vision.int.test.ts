import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { SidecarClient } from '../../src/main/sidecar/client'
import { SIDECAR_METHODS } from '@shared/sidecar/protocol'
import { FFMPEG, outputDir, run, writeNote } from './output'

/**
 * The Director's objective checks, through the real sidecar (docs/PLAN.md §4.2).
 *
 * Each measurement against a picture whose answer is known by construction: a
 * checkerboard and the same board blurred (sharpness), a near-black and a
 * near-white card (exposure), one test pattern at two sizes and turned on its
 * side (the perceptual hash), and two different flat cards — which must NOT
 * match, although their hashes would both be all zeros.
 *
 * Needs the sidecar's own interpreter with numpy and scipy; CI's bare Python
 * has neither, so this skips there, as the beat and depth checks do.
 */

const SIDECAR_DIR = resolve(__dirname, '../../sidecar')
const VENV_PYTHON = join(SIDECAR_DIR, '.venv/bin/python')
const maybe = existsSync(VENV_PYTHON) ? describe : describe.skip

interface Measure {
  path: string
  sharpness: number
  luma: number
  darkClip: number
  brightClip: number
  dhash: string | null
  width: number
  height: number
  error?: string
}

let dir = ''
let client: SidecarClient
const files: Record<string, string> = {}

async function lavfi(name: string, source: string, vf = 'null'): Promise<void> {
  files[name] = join(dir, `${name}.png`)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-vf', vf, '-frames:v', '1', files[name]])
}

function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

maybe('vision.measure', () => {
  let measures: Record<string, Measure> = {}

  beforeAll(async () => {
    dir = await outputDir('vision')
    const board = 'color=c=white:s=640x480,geq=lum=if(mod(floor(X/16)+floor(Y/16)\\,2)\\,235\\,20):cb=128:cr=128'
    await lavfi('sharp', board)
    await lavfi('soft', board, 'boxblur=8')
    await lavfi('dark', 'color=c=0x141414:s=640x480')
    await lavfi('blown', 'color=c=0xfafafa:s=640x480')
    await lavfi('pattern', 'testsrc=s=640x480:d=1')
    await lavfi('pattern-small', 'testsrc=s=640x480:d=1', 'scale=480:360')
    await lavfi('pattern-turned', 'testsrc=s=640x480:d=1', 'transpose=1')
    await lavfi('flat-red', 'color=c=red:s=640x480')
    await lavfi('flat-blue', 'color=c=blue:s=640x480')

    client = new SidecarClient({ cwd: SIDECAR_DIR, python: VENV_PYTHON, maxRestarts: 0 })
    await client.start()
    const result = await client.request<{ measures: Measure[] }>(SIDECAR_METHODS.visionMeasure, {
      paths: [...Object.values(files), join(dir, 'missing.png')],
      ffmpeg: FFMPEG,
      ffprobe: ffprobeInstaller.path
    })
    measures = Object.fromEntries(result.measures.map((m) => [Object.keys(files).find((k) => files[k] === m.path) ?? 'missing', m]))
    await writeNote(dir, [
      '# vision.measure',
      '',
      ...Object.entries(measures).map(
        ([k, m]) => `- ${k}: ${m.error ?? `sharpness ${m.sharpness.toFixed(1)}, luma ${m.luma.toFixed(3)}, dark ${m.darkClip.toFixed(2)}, bright ${m.brightClip.toFixed(2)}, dhash ${m.dhash}`}`
      )
    ])
  }, 120_000)

  afterAll(() => client?.stop())

  it('sees blur: the blurred board measures far softer than the sharp one', () => {
    expect(measures.sharp.sharpness / measures.soft.sharpness).toBeGreaterThan(10)
  })

  it('sees exposure: a near-black card reads dark, a near-white one reads blown', () => {
    // 0x14 is level 20: dark, but above the clip threshold of 8 — not clipped.
    expect(measures.dark.luma).toBeLessThan(0.1)
    expect(measures.dark.darkClip).toBe(0)
    expect(measures.blown.luma).toBeGreaterThan(0.95)
    expect(measures.blown.brightClip).toBe(1)
  })

  it('matches one picture at two sizes, and not the same picture turned', () => {
    const a = measures.pattern.dhash!
    expect(hamming(a, measures['pattern-small'].dhash!)).toBeLessThanOrEqual(6)
    expect(hamming(a, measures['pattern-turned'].dhash!)).toBeGreaterThan(12)
  })

  it('measures every picture at one size, so a smaller copy is not sharper than its original', () => {
    expect(measures['pattern-small'].sharpness).toBeLessThanOrEqual(measures.pattern.sharpness * 1.02)
  })

  it('gives a flat picture no hash, so two plain cards never count as copies', () => {
    expect(measures['flat-red'].dhash).toBeNull()
    expect(measures['flat-blue'].dhash).toBeNull()
    expect(measures.pattern.dhash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reports the size, and a missing file as an error for that file alone', () => {
    expect([measures.pattern.width, measures.pattern.height]).toEqual([640, 480])
    expect(measures['pattern-turned'].width).toBe(480)
    expect(measures.missing.error).toMatch(/No such image/)
  })
})
