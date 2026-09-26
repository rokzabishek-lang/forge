import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type Project } from '@shared/timeline'
import { probeImports, readableStill } from '../../src/main/imports'
import { probeMany } from '../../src/main/ffmpeg/probe'
import { FFMPEG, run, outputDir, pixelAt, writeNote } from './output'

/*
 * An AVIF photo imports, and renders (src/main/imports.ts).
 *
 * The bundled ffmpeg cannot open one — measured here each run, and written to
 * the note — so the import converts it to a PNG the render reads. A solid
 * colour saved as AVIF, imported, put on the timeline and rendered: the frame
 * is that colour. A PNG beside it imports untouched, under its own path.
 */

const colour = { r: 200, g: 30, b: 120 }
let dir = ''
let avif = ''
let png = ''

beforeAll(async () => {
  dir = await outputDir('importAvif')
  avif = join(dir, 'photo one.avif')
  png = join(dir, 'plain.png')
  await sharp({ create: { width: 64, height: 64, channels: 3, background: colour } }).avif({ quality: 80 }).toFile(avif)
  await sharp({ create: { width: 64, height: 64, channels: 3, background: colour } }).png().toFile(png)
}, 60_000)

describe('an AVIF still', () => {
  it('imports as a PNG under its own name, and renders its colour', async () => {
    const ffmpegAlone = await probeMany([avif])
    const converted = join(dir, 'converted')
    const { assets, failed } = await probeImports([avif, png], 30, converted)
    expect(failed).toEqual([])
    expect(assets.map((a) => a.name)).toEqual(['photo one.avif', 'plain.png'])
    const [still, plain] = assets
    expect(still.path.endsWith('.png')).toBe(true)
    expect(dirname(still.path)).toBe(converted)
    expect(basename(still.path)).not.toMatch(/[<>:"|?*]/)
    expect([still.width, still.height, still.kind]).toEqual([64, 64, 'image'])
    // The plain PNG is the file itself.
    expect(plain.path).toBe(png)

    // Imported again, the same PNG — not converted twice.
    const before = (await stat(still.path)).mtimeMs
    const again = await readableStill(avif, converted)
    expect(again.path).toBe(still.path)
    expect((await stat(still.path)).mtimeMs).toBe(before)

    const clip: Clip = {
      id: 'c', assetId: still.id, trackId: 'v1', start: 0, duration: 6, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
    }
    const base = emptyProject()
    const project: Project = { ...base, settings: { ...base.settings, width: 64, height: 64, fps: 30 }, assets: [still], clips: [clip] }
    const out = join(dir, 'avif.mp4')
    await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, { maxBuffer: 32 * 1024 * 1024 })
    expect(existsSync(out)).toBe(true)
    const got = await pixelAt(out, 0.1, 32, 32, { width: 64, height: 64 })
    await writeNote(dir, [
      '# importAvif',
      '',
      `- ffmpeg alone on the AVIF: ${ffmpegAlone.failed.length ? `refused — ${ffmpegAlone.failed[0].error.split('\n')[0]}` : 'READ IT — the conversion may no longer be needed'}`,
      `- imported: ${basename(still.path)} in converted/, ${still.width}×${still.height}, named "${still.name}"`,
      `- rendered centre: rgb(${got.join(', ')}), want rgb(${colour.r}, ${colour.g}, ${colour.b})`
    ])
    for (const [k, want] of [colour.r, colour.g, colour.b].entries()) expect(Math.abs(got[k] - want), `channel ${k}`).toBeLessThan(14)
  }, 120_000)

  it('a file that will not convert fails on its own, under the name the user chose', async () => {
    const bad = join(dir, 'broken.avif')
    await sharp({ create: { width: 8, height: 8, channels: 3, background: colour } }).png().toFile(join(dir, 'broken.png'))
    // Not an AVIF at all: the bytes of nothing.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(bad, Buffer.alloc(16))
    const { assets, failed } = await probeImports([bad, png], 30, join(dir, 'converted'))
    expect(assets.map((a) => a.name)).toEqual(['plain.png'])
    expect(failed).toHaveLength(1)
    expect(failed[0].path).toBe(bad)
    expect(failed[0].error).toMatch(/broken\.avif could not be converted/)
  }, 60_000)
})
