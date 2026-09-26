import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { STEM_MAX, locateAsset, probeImports, readableStill, relinkable } from '../../src/main/imports'
import { probeMany } from '../../src/main/ffmpeg/probe'
import { FFMPEG, run, outputDir, pixelAt, writeNote } from './output'

/*
 * An AVIF photo imports, and renders (src/main/imports.ts).
 *
 * The bundled ffmpeg cannot open one — measured here each run, and written to
 * the note — so the import converts it to a PNG the render reads. A solid
 * colour saved as AVIF, imported, put on the timeline and rendered: the frame
 * is that colour. A PNG beside it imports untouched, under its own path. The
 * asset stands for the AVIF (`source`) and reads the PNG (`path`): a project
 * that moves finds the AVIF again and remakes the copy.
 */

const colour = { r: 200, g: 30, b: 120 }
let dir = ''
let avif = ''
let png = ''

async function solidAvif(file: string, size = 64): Promise<string> {
  await sharp({ create: { width: size, height: size, channels: 3, background: colour } }).avif({ quality: 80 }).toFile(file)
  return file
}

beforeAll(async () => {
  dir = await outputDir('importAvif')
  avif = await solidAvif(join(dir, 'photo one.avif'))
  png = join(dir, 'plain.png')
  await sharp({ create: { width: 64, height: 64, channels: 3, background: colour } }).png().toFile(png)
}, 60_000)

describe('an AVIF still', () => {
  it('imports as a PNG under its own name, standing for the AVIF, and renders its colour', async () => {
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
    // The asset stands for the file the user chose: its path for relinking, its size for a relink's tie-break.
    expect(still.source).toBe(avif)
    expect(still.size).toBe((await stat(avif)).size)
    // The plain PNG is the file itself, and stands for nothing else.
    expect(plain.path).toBe(png)
    expect(plain.source).toBeUndefined()

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
      `- imported: ${basename(still.path)} in converted/, ${still.width}×${still.height}, named "${still.name}", standing for ${basename(still.source!)}`,
      `- rendered centre: rgb(${got.join(', ')}), want rgb(${colour.r}, ${colour.g}, ${colour.b})`
    ])
    for (const [k, want] of [colour.r, colour.g, colour.b].entries()) expect(Math.abs(got[k] - want), `channel ${k}`).toBeLessThan(14)
  }, 120_000)

  it('a copy the cache holds that will not open is made again, whole; a stray part-file never stands in', async () => {
    const converted = join(dir, 'converted-broken')
    const first = await readableStill(avif, converted)
    // Cut the cached copy short, as a quit mid-write once could — and now cannot, since a copy is moved into place whole.
    await writeFile(first.path, Buffer.alloc(300))
    const again = await readableStill(avif, converted)
    expect(again.path).toBe(first.path)
    expect((await sharp(again.path).metadata()).width).toBe(64)
    expect((await readdir(converted)).filter((f) => f.endsWith('.part'))).toEqual([])
  }, 60_000)

  it('a name long enough to break the cache path is cut to fit, and still imports', async () => {
    const long = await solidAvif(join(dir, `${'a'.repeat(200)}.avif`))
    const { assets, failed } = await probeImports([long], 30, join(dir, 'converted'))
    expect(failed).toEqual([])
    expect(basename(assets[0].path).length).toBeLessThan(STEM_MAX + 40)
    expect(assets[0].name).toBe(basename(long))
  }, 60_000)

  it('a file that will not convert fails on its own, under the name the user chose; a HEIC says what it needs', async () => {
    const bad = join(dir, 'broken.avif')
    await writeFile(bad, Buffer.alloc(16))
    const { assets, failed } = await probeImports([bad, png], 30, join(dir, 'converted'))
    expect(assets.map((a) => a.name)).toEqual(['plain.png'])
    expect(failed).toHaveLength(1)
    expect(failed[0].path).toBe(bad)
    expect(failed[0].error).toMatch(/broken\.avif could not be converted/)
    // sharp's own words for a HEIC it cannot decode are "bad seek" and "unable to write"; the user needs the reason.
    const heic = join(dir, 'phone.heic')
    await writeFile(heic, Buffer.alloc(16))
    const { failed: heicFailed } = await probeImports([heic], 30, join(dir, 'converted'))
    expect(heicFailed[0].error).toMatch(/phone\.heic could not be converted — HEIC needs an HEVC decoder/)
  }, 60_000)

  it('a probe that fails on the copy is reported against the file the user chose', async () => {
    const converted = join(dir, 'converted')
    const probe: typeof probeMany = async (paths) => ({ ok: [], failed: paths.map((p) => ({ path: p, error: 'ffprobe refused' })) })
    const { failed } = await probeImports([avif, png], 30, converted, probe)
    expect(failed.map((f) => f.path)).toEqual([avif, png])
  })

  it('a project that moved finds the AVIF again and remakes the copy; one that lost only the cache remakes it too', async () => {
    const cache = join(dir, 'converted-open')
    const home = join(dir, 'home')
    const moved = join(dir, 'moved')
    await mkdir(home, { recursive: true })
    await mkdir(moved, { recursive: true })
    const source = await solidAvif(join(home, 'photo2.avif'))
    const [asset] = (await probeImports([source], 30, cache)).assets
    const converted: MediaAsset = { ...asset, relativeTo: 'photo2.avif' }

    // The cache emptied: the source is where it was, so the copy is made again under the same name.
    await rm(cache, { recursive: true, force: true })
    const remade = await locateAsset(converted, home, [], cache)
    expect(remade.offline).toBeUndefined()
    expect(remade.source).toBe(source)
    expect(existsSync(remade.path)).toBe(true)

    // The whole folder moved to another machine: found relative to the project, converted there.
    await copyFile(source, join(moved, 'photo2.avif'))
    await rm(source)
    const found = await locateAsset(converted, moved, [], cache)
    expect(found.offline).toBeUndefined()
    expect(found.source).toBe(join(moved, 'photo2.avif'))
    expect(existsSync(found.path)).toBe(true)

    // Nowhere: offline, as any other missing file.
    const lost = await locateAsset(converted, home, [], cache)
    expect(lost.offline).toBe(true)

    // A relink to the AVIF hands back the copy and the file; to a PNG, the file alone.
    const relinked = await relinkable({ x: join(moved, 'photo2.avif'), y: png }, cache)
    expect(relinked.y).toBe(png)
    expect(relinked.x).toMatchObject({ source: join(moved, 'photo2.avif') })
    expect(existsSync((relinked.x as { path: string }).path)).toBe(true)
  }, 60_000)
})
