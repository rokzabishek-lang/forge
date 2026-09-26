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
  backdropClip: number
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
    // A product-listing photo: a grey box on a white studio backdrop — 87 % of it clipped white, by design.
    await lavfi('backdrop', 'color=c=white:s=640x480', 'drawbox=x=220:y=140:w=200:h=200:c=0x808080:t=fill')
    // A blown photo: two white patches burnt INTO a mid-grey picture, touching no edge.
    await lavfi('highlights', 'color=c=0x808080:s=640x480', 'drawbox=x=100:y=100:w=80:h=80:c=white:t=fill,drawbox=x=400:y=300:w=80:h=80:c=white:t=fill')
    // A blown dress running off the bottom of a portrait: one edge touched, and it is still the subject.
    await lavfi('dress', 'color=c=0x808080:s=640x480', 'drawbox=x=200:y=300:w=240:h=180:c=white:t=fill')
    // A white sky: a band across the top, reaching both sides — backdrop.
    await lavfi('sky', 'color=c=0x808080:s=640x480', 'drawbox=x=0:y=0:w=640:h=150:c=white:t=fill')

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
        ([k, m]) => `- ${k}: ${m.error ?? `sharpness ${m.sharpness.toFixed(1)}, luma ${m.luma.toFixed(3)}, dark ${m.darkClip.toFixed(2)}, bright ${m.brightClip.toFixed(3)} of which backdrop ${m.backdropClip.toFixed(3)}, dhash ${m.dhash}`}`
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
    // All of it reaches the edge: a blank white card is all backdrop, and no highlight.
    expect(measures.blown.backdropClip).toBe(1)
  })

  it('sets a white backdrop apart from blown highlights: clipped white that reaches the frame’s edge is backdrop', () => {
    // The box on white: nearly nine tenths clipped, every clipped pixel in the one region around the box.
    const backdrop = measures.backdrop
    expect(backdrop.brightClip).toBeGreaterThan(0.8)
    expect(Math.abs(backdrop.backdropClip - backdrop.brightClip)).toBeLessThan(0.005)
    // The burnt patches: four per cent clipped, none of it touching an edge — so all of it counts.
    const highlights = measures.highlights
    expect(highlights.brightClip).toBeGreaterThan(0.03)
    expect(highlights.brightClip).toBeLessThan(0.05)
    expect(highlights.backdropClip).toBe(0)
    // The dress runs off one edge: touching is not spanning, so it stays blown.
    expect(measures.dress.brightClip).toBeGreaterThan(0.1)
    expect(measures.dress.backdropClip).toBe(0)
    // The sky spans the top from side to side: backdrop, every bit of it.
    expect(measures.sky.brightClip).toBeGreaterThan(0.25)
    expect(Math.abs(measures.sky.backdropClip - measures.sky.brightClip)).toBeLessThan(0.005)
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
