import { existsSync } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app } from 'electron'
import sharp from 'sharp'
import type { MediaAsset } from '@shared/timeline'
import { extOf } from '@shared/media'
import { candidatePaths, type Relinked } from '@shared/project/relink'
import { toAsset } from './assets'
import { probeMany } from './ffmpeg/probe'

/**
 * Stills the bundled ffmpeg cannot read, made readable on import.
 *
 * AVIF and HEIC are what a web page and a phone hand over today, and both
 * bundled ffmpegs refuse them — measured 2026-09-26 on the first real Director
 * run, four product photos saved from a shop page: "moov atom not found" from
 * the macOS build; the Windows build is from December 2018, before either
 * format had a decoder anywhere. `IMAGE_EXT` has listed both all along, so the
 * open dialog offered them and the import then failed.
 *
 * sharp's libvips reads them (libheif 1.23 with an AVIF decoder on every
 * platform sharp ships prebuilt; HEIC needs an HEVC decoder sharp does not
 * ship, so such a file says so instead of importing). So a still of these
 * kinds is converted to a PNG under userData/converted — keyed by the file's
 * size and mtime like every other cache here, so a replaced file is converted
 * again and an untouched one never twice — and the asset reads the PNG while
 * standing for the file the user imported: `path` is the copy, `source` the
 * file, and the project travels by the file (relink.ts, `locateAsset` below).
 * `rotate()` with no argument bakes the EXIF orientation in, which a phone's
 * HEIC nearly always carries and ffmpeg would never see.
 */
export const CONVERT_EXT: ReadonlySet<string> = new Set(['avif', 'heic', 'heif'])

/**
 * The most of the original's name the cache file carries. A name legal on its
 * own can push the cache path past a limit: measured, a 241-character name
 * became a 258-character one and sharp could not open it for writing; on
 * Windows the whole path must stay under 260.
 */
export const STEM_MAX = 48

export function needsConversion(path: string): boolean {
  return CONVERT_EXT.has(extOf(path))
}

export function convertedDir(): string {
  return join(app.getPath('userData'), 'converted')
}

export interface Readable {
  /** The file ffmpeg reads: the PNG, or the file itself. */
  path: string
  /** The file's own name, for the pool. */
  name: string
  /** The imported file's size: what a relink compares, and what says "not drawn" (`size > 0`). */
  size: number
  /** The imported file, when `path` is a converted copy of it. */
  source?: string
}

/** Is the cached copy a picture that opens? One cut short by a quit mid-write is not. */
async function usable(png: string): Promise<boolean> {
  try {
    const meta = await sharp(png).metadata()
    return (meta.width ?? 0) > 0 && (meta.height ?? 0) > 0
  } catch {
    return false
  }
}

/** The file ffmpeg can read for a still, converting it when it cannot. Throws when the file cannot be read or will not convert. */
export async function readableStill(path: string, dir = convertedDir()): Promise<Readable> {
  const name = basename(path)
  const info = await stat(path).catch(() => null)
  if (!info) throw new Error(`${name} could not be read`)
  if (!needsConversion(path)) return { path, name, size: info.size }
  await mkdir(dir, { recursive: true })
  // `size:mtime` would carry a colon, which Windows forbids in a file name.
  const stem = name.slice(0, name.length - extOf(path).length - 1).slice(0, STEM_MAX)
  const out = join(dir, `${info.size}-${Math.round(info.mtimeMs)}-${stem}.png`)
  if (!existsSync(out) || !(await usable(out))) {
    /*
     * Written under a name of its own and moved into place whole: a quit
     * mid-write leaves a stray `.part`, never a half copy under the real name
     * that every later import would trust. Two imports of one file at once
     * each write their own and the last move wins with a whole picture.
     */
    const partial = `${out}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`
    try {
      await sharp(path).rotate().png().toFile(partial)
      await rename(partial, out)
    } catch (err) {
      await rm(partial, { force: true }).catch(() => undefined)
      const why = err instanceof Error ? err.message : String(err)
      // sharp's own words for a HEIC are "bad seek" and "unable to write", which read as a broken file or a full disk.
      if (/^hei[cf]$/.test(extOf(path))) {
        throw new Error(`${name} could not be converted — HEIC needs an HEVC decoder this build does not have; save it as JPEG or PNG first`)
      }
      throw new Error(`${name} could not be converted: ${why}`)
    }
  }
  return { path: out, name, size: info.size, source: path }
}

/**
 * The assets for an import — what `media:probe` answers: every file probed
 * through a copy ffmpeg can read, each asset under the file's own name and
 * size, and every failure reported against the file the user chose, not the
 * copy. `probe` is what runs ffprobe; a test can hand in one that fails.
 */
export async function probeImports(
  paths: string[],
  projectFps: number,
  dir = convertedDir(),
  probe: typeof probeMany = probeMany
): Promise<{ assets: MediaAsset[]; failed: { path: string; error: string }[] }> {
  const failed: { path: string; error: string }[] = []
  const readable: Readable[] = []
  for (const source of paths) {
    try {
      readable.push(await readableStill(source, dir))
    } catch (err) {
      failed.push({ path: source, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const probed = await probe(readable.map((r) => r.path))
  const byPath = new Map(readable.map((r) => [r.path, r]))
  const assets = probed.ok.map((info) => {
    const r = byPath.get(info.path)
    const asset = toAsset({ ...info, name: r?.name ?? info.name, size: r?.size ?? info.size }, projectFps)
    return r?.source ? { ...asset, source: r.source } : asset
  })
  for (const f of probed.failed) failed.push({ path: byPath.get(f.path)?.source ?? f.path, error: f.error })
  return { assets, failed }
}

/**
 * Where an asset's file is now, for `project:open`: the first place it can be
 * (relink.ts `candidatePaths` — absolute, relative to the project, the folders
 * the project knows), and for a converted still the copy remade when the
 * cache has lost it. Marked offline when it is nowhere; a self-drawn asset has
 * no file to find.
 */
export async function locateAsset(
  asset: MediaAsset,
  projectDir: string,
  searchFolders: string[],
  dir = convertedDir()
): Promise<MediaAsset> {
  if (asset.size === 0) return asset
  const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)
  for (const candidate of candidatePaths(asset, projectDir, searchFolders)) {
    if (!(await exists(candidate))) continue
    if (asset.source === undefined) return candidate === asset.path ? asset : { ...asset, path: candidate }
    // A converted still: the file it was made from, wherever it is now — and its copy, remade if the cache lost it.
    if (candidate === asset.source && (await exists(asset.path))) return asset
    try {
      const made = await readableStill(candidate, dir)
      return { ...asset, path: made.path, source: candidate }
    } catch {
      return { ...asset, offline: true }
    }
  }
  return { ...asset, offline: true }
}

/** What a relink found, with every still ffmpeg cannot read converted first; one that will not convert is not relinked. */
export async function relinkable(found: Record<string, string>, dir = convertedDir()): Promise<Record<string, Relinked>> {
  const out: Record<string, Relinked> = {}
  for (const [id, file] of Object.entries(found)) {
    if (!needsConversion(file)) {
      out[id] = file
      continue
    }
    try {
      out[id] = { path: (await readableStill(file, dir)).path, source: file }
    } catch {
      // Left out: the pool keeps showing it offline, which is the truth.
    }
  }
  return out
}
