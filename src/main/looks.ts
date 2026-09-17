import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { LOOKS, cubeFor } from '@shared/render/looks'

/**
 * The shipped looks, as real files on disk.
 *
 * They are written rather than bundled so there is exactly one kind of LUT in
 * the product: a `.cube` on disk with a path. ffmpeg reads it, the GPU preview
 * fetches it, and a look the user loaded themselves goes down the identical
 * path. Nothing has to know which is which.
 */

export interface BuiltInLook {
  id: string
  name: string
  description: string
  file: string
}

/**
 * Bump when a look's maths changes, so an old file is replaced rather than
 * quietly kept — the filename alone cannot say which version wrote it.
 */
const LOOKS_VERSION = 1

function looksDir(): string {
  return join(app.getPath('userData'), 'looks', `v${LOOKS_VERSION}`)
}

let cached: BuiltInLook[] | null = null

export async function ensureLooks(): Promise<BuiltInLook[]> {
  if (cached) return cached

  const dir = looksDir()
  await mkdir(dir, { recursive: true })

  const written: BuiltInLook[] = []
  for (const look of LOOKS) {
    const file = join(dir, `${look.id}.cube`)
    // Generating 4,913 entries is fast, but not free, and this runs on every
    // launch — so only write what is missing.
    if (!(await exists(file))) await writeFile(file, cubeFor(look), 'utf8')
    written.push({ id: look.id, name: look.name, description: look.description, file })
  }

  cached = written
  return written
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
