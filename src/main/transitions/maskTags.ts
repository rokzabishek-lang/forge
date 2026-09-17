import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { FFMPEG_PATH } from '../ffmpeg/paths'
import { classifyMask, type MaskTag } from '@shared/transitions/classify'

const run = promisify(execFile)

/**
 * Tagging the transition masks by what they do.
 *
 * Decoding happens here because it needs ffmpeg; the judgement lives in
 * `shared/transitions/classify` where it can be tested against masks built by
 * hand. Results are cached to disk keyed by size and mtime — 413 masks is a few
 * seconds of work and nothing about a file on disk changes between launches.
 */

const PROBE_SIZE = 32
const CACHE_VERSION = 1

interface CacheEntry {
  key: string
  /**
   * `null` records a mask ffmpeg could not decode.
   *
   * Seven of the bundled masks are `.svg`, and the bundled ffmpeg has no svg
   * decoder — it answers "Decoder (codec svg) not found". A failure used to be
   * left out of the cache entirely, so those seven re-spawned ffmpeg on every
   * launch, forever, on every platform. Remembering the failure costs one null
   * and makes a cold start the only time they are tried.
   */
  tags: MaskTag[] | null
}

function cachePath(): string {
  const base = process.env.FORGE_CACHE_DIR ?? join(homedir(), '.cache', 'forge')
  return join(base, `mask-tags-v${CACHE_VERSION}.json`)
}

/** Decode a mask to a small square of luma. */
async function probe(file: string): Promise<Uint8Array | null> {
  try {
    const { stdout } = await run(
      FFMPEG_PATH,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file,
       // Square on purpose: the mask is stretched to the canvas at render time,
       // so its own aspect ratio is not part of what it does.
       '-vf', `scale=${PROBE_SIZE}:${PROBE_SIZE},format=gray`,
       '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'],
      // windowsHide, like every other spawn in main. Without it a packaged
      // Electron app has no console of its own, so each console-subsystem
      // child gets a freshly allocated window — and this one runs in a loop
      // over 412 masks, so the first launch would be 412 of them.
      { encoding: 'buffer', maxBuffer: 1 << 20, windowsHide: true }
    )
    const buffer = stdout as unknown as Buffer
    return buffer.length === PROBE_SIZE * PROBE_SIZE ? new Uint8Array(buffer) : null
  } catch {
    return null
  }
}

export async function tagMasks(
  files: { id: string; file: string }[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, MaskTag[]>> {
  let cache: Record<string, CacheEntry> = {}
  try {
    cache = JSON.parse(await readFile(cachePath(), 'utf8')) as Record<string, CacheEntry>
  } catch {
    cache = {}
  }

  const result = new Map<string, MaskTag[]>()
  let done = 0
  let dirty = false

  for (const { id, file } of files) {
    let key = ''
    try {
      const info = await stat(file)
      key = `${info.size}:${Math.round(info.mtimeMs)}`
    } catch {
      done++
      continue
    }

    const cached = cache[id]
    if (cached && cached.key === key) {
      // A cached null is a mask known not to decode — skip it without asking
      // ffmpeg again, which is the whole point of storing it.
      if (cached.tags) result.set(id, cached.tags)
      done++
      continue
    }

    const gray = await probe(file)
    const tags = gray ? classifyMask(gray, PROBE_SIZE) : null
    if (tags) result.set(id, tags)
    cache[id] = { key, tags }
    dirty = true
    done++
    onProgress?.(done, files.length)
  }

  if (dirty) {
    try {
      await mkdir(dirname(cachePath()), { recursive: true })
      await writeFile(cachePath(), JSON.stringify(cache), 'utf8')
    } catch {
      // A cache that cannot be written costs seconds, not correctness.
    }
  }

  return result
}
