import { mkdir, access, writeFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import sharp from 'sharp'
import { resolveAssetFile } from './scan'

/**
 * Prepare a library asset for the timeline.
 *
 * SVG is the reason this exists: browsers render it natively, ffmpeg does not
 * decode it at all. Stickers and titles are therefore rasterised once to PNG and
 * cached, so the same file works in both the preview and the render. Raster
 * formats pass through untouched.
 */

/** Rasterised at this height; wide enough to scale up a little without softening. */
const RASTER_HEIGHT = 1024

function cacheDir(): string {
  return join(app.getPath('userData'), 'raster')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function preparePlaceableFile(relativePath: string): Promise<string> {
  const absolute = resolveAssetFile(relativePath)
  if (extname(absolute).toLowerCase() !== '.svg') return absolute

  // Keyed by path so a library file that changes on disk produces a new cache
  // entry rather than serving a stale raster forever.
  const key = createHash('sha1').update(relativePath).digest('hex').slice(0, 16)
  const target = join(cacheDir(), `${key}.png`)
  if (await exists(target)) return target

  await mkdir(cacheDir(), { recursive: true })
  const png = await sharp(absolute, { density: 300 })
    .resize({
      height: RASTER_HEIGHT,
      fit: 'contain',
      // Transparent, not white: these are overlays, and a white box behind a
      // sticker defeats the entire point of placing it over video.
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer()

  await writeFile(target, png)
  return target
}

export function placeableName(relativePath: string): string {
  return basename(relativePath).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
}
