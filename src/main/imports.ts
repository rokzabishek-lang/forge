import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app } from 'electron'
import sharp from 'sharp'
import type { MediaAsset } from '@shared/timeline'
import { extOf } from '@shared/media'
import { fileKey, toAsset } from './assets'
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
 * ship, so such a file reports why instead of importing). So a still of these
 * kinds is converted to a PNG under userData/converted — keyed by the file's
 * size and mtime like every other cache here, so a replaced file is converted
 * again and an untouched one never twice — and the asset points at the PNG
 * while keeping the file's own name: the pool shows photo1.avif, and ffmpeg
 * reads its pixels from a file it can open. `rotate()` with no argument bakes
 * the EXIF orientation in, which a phone's HEIC nearly always carries and
 * ffmpeg would never see.
 */
export const CONVERT_EXT: ReadonlySet<string> = new Set(['avif', 'heic', 'heif'])

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
  converted: boolean
}

/** The file ffmpeg can read for a still, converting it when it cannot. Throws when the file will not convert. */
export async function readableStill(path: string, dir = convertedDir()): Promise<Readable> {
  const name = basename(path)
  if (!needsConversion(path)) return { path, name, converted: false }
  const key = await fileKey(path)
  if (key === null) throw new Error(`${name} could not be read`)
  await mkdir(dir, { recursive: true })
  // `size:mtime` carries a colon, which Windows forbids in a file name.
  const stem = name.slice(0, name.length - extOf(path).length - 1)
  const out = join(dir, `${key.replace(':', '-')}-${stem}.png`)
  if (!existsSync(out)) {
    try {
      await sharp(path).rotate().png().toFile(out)
    } catch (err) {
      throw new Error(`${name} could not be converted: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { path: out, name, converted: true }
}

/**
 * The assets for an import — what `media:probe` answers: every file probed
 * through a copy ffmpeg can read, each asset under the file's own name, and
 * every failure reported against the file the user chose, not the copy.
 */
export async function probeImports(
  paths: string[],
  projectFps: number,
  dir = convertedDir()
): Promise<{ assets: MediaAsset[]; failed: { path: string; error: string }[] }> {
  const failed: { path: string; error: string }[] = []
  const readable: (Readable & { source: string })[] = []
  for (const source of paths) {
    try {
      readable.push({ source, ...(await readableStill(source, dir)) })
    } catch (err) {
      failed.push({ path: source, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const probed = await probeMany(readable.map((r) => r.path))
  const bySource = new Map(readable.map((r) => [r.path, r]))
  const assets = probed.ok.map((info) => toAsset({ ...info, name: bySource.get(info.path)?.name ?? info.name }, projectFps))
  for (const f of probed.failed) failed.push({ path: bySource.get(f.path)?.source ?? f.path, error: f.error })
  return { assets, failed }
}
