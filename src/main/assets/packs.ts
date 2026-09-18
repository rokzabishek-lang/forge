import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  BUILT_IN_MANIFEST,
  isValidPackId,
  mergeManifest,
  packProgress,
  packState,
  safeMemberPath,
  type Pack,
  type PackState
} from '@shared/assets/pack'
import { readTar } from '@shared/assets/tar'
import { CancelledError } from '../ffmpeg/run'

/**
 * Installing an asset pack.
 *
 * Packs go under `userData`, never beside the app. The install directory is
 * `%LOCALAPPDATA%\Programs\Forge` on Windows and inside the bundle on macOS,
 * and writing there means an update silently deletes everything the user
 * downloaded. `userData` survives updates, is writable without elevation, and
 * is already where the app keeps stems, downloads and the fetched yt-dlp.
 *
 * Archives are `.tar.gz` so this needs no native dependency — see
 * `@shared/assets/tar` for why that mattered. Everything is verified before a
 * single file is written: this downloads and unpacks an archive from the
 * network, and "we published it" is not the same as "it arrived intact".
 */

const MANIFEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000

/** Where installed packs live. `assetsRoot()` prefers this when it has content. */
export function packRoot(): string {
  return join(app.getPath('userData'), 'assets')
}

function receiptPath(id: string): string {
  return join(packRoot(), '.packs', `${id}.json`)
}

interface Receipt {
  id: string
  version: number
  installedAt: string
  files: number
}

/** The version of a pack on disk, or null if it is not installed. */
export async function installedVersion(id: string): Promise<number | null> {
  try {
    const receipt = JSON.parse(await readFile(receiptPath(id), 'utf8')) as Receipt
    return Number.isInteger(receipt.version) ? receipt.version : null
  } catch {
    return null
  }
}

/**
 * Has anything at all been installed?
 *
 * `assetsRoot()` uses this to decide whether to prefer the pack root over a
 * bundled or development `assets/` folder. Cheap on purpose — it runs at
 * startup, before the first catalog scan.
 */
export async function packRootHasContent(): Promise<boolean> {
  try {
    const entries = await readdir(packRoot())
    return entries.some((name) => name !== '.packs')
  } catch {
    return false
  }
}

export interface PackListing extends Pack {
  state: PackState
}

/**
 * Every pack this build knows about, with what is installed.
 *
 * The built-in list answers instantly; a fetched list is layered over it when
 * one is reachable. A failed refresh is not an error worth showing — the
 * built-in list is a complete, working answer, and the panel must open whether
 * or not a server is up.
 */
export async function listPacks(options: { refresh?: boolean } = {}): Promise<PackListing[]> {
  let packs = BUILT_IN_MANIFEST.packs

  if (options.refresh) {
    try {
      const url = BUILT_IN_MANIFEST.packs[0]?.url.replace(/[^/]+$/, 'manifest.json')
      if (url) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
        try {
          const response = await fetch(url, { signal: controller.signal })
          if (response.ok) packs = mergeManifest(BUILT_IN_MANIFEST, await response.json()).packs
        } finally {
          clearTimeout(timer)
        }
      }
    } catch {
      // Offline, or no manifest published yet. The built-in list stands.
    }
  }

  return Promise.all(
    packs.map(async (pack) => ({ ...pack, state: packState(pack, await installedVersion(pack.id)) }))
  )
}

export interface InstallOptions {
  signal?: AbortSignal
  onProgress?: (progress: number | null, message: string) => void
}

/**
 * Fetch, verify and unpack one pack.
 *
 * Order matters and is the whole design: the archive is fully downloaded and
 * its checksum checked BEFORE anything is written into the library. A pack that
 * arrives truncated or altered leaves the existing library untouched rather
 * than half-replacing it, which is the difference between "try again" and
 * "reinstall the app".
 */
export async function installPack(pack: Pack, options: InstallOptions = {}): Promise<PackListing> {
  const { signal, onProgress } = options
  if (!isValidPackId(pack.id)) throw new Error(`Refusing a pack with an unusable id: ${pack.id}`)
  const stop = (): void => {
    if (signal?.aborted) throw new CancelledError()
  }
  stop()

  onProgress?.(0, `fetching ${pack.name}`)
  const archive = await download(pack, signal, onProgress)
  stop()

  onProgress?.(null, 'checking what arrived')
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== pack.sha256) {
    throw new Error(
      `${pack.name} did not match its published checksum (${actual.slice(0, 12)}… vs ${pack.sha256.slice(0, 12)}…). Nothing was installed.`
    )
  }

  onProgress?.(null, 'unpacking')
  const tar = gunzipSync(archive)
  const entries = readTar(tar, safeMemberPath)
  stop()

  /*
   * Into a staging directory, then swapped in.
   *
   * Writing straight into the live folder means a cancel halfway leaves a
   * half-installed pack that looks installed — the receipt is what marks it
   * complete, and it is written last for exactly that reason.
   */
  const target = join(packRoot(), pack.id)
  const staging = `${target}.installing`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  try {
    let written = 0
    for (const entry of entries) {
      stop()
      const out = join(staging, entry.name)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, tar.subarray(entry.offset, entry.offset + entry.size))
      // Only the executable bit, and only where it was set. Packs contain data,
      // but restoring the mode wholesale would be a way to smuggle one in.
      if (process.platform !== 'win32' && (entry.mode & 0o111) !== 0) {
        await chmod(out, 0o755)
      }
      written++
      if (written % 25 === 0) onProgress?.(null, `unpacking ${written} of ${entries.length}`)
    }

    await rm(target, { recursive: true, force: true })
    // `rename` across the same volume is atomic; both paths are under userData.
    const { rename } = await import('node:fs/promises')
    await rename(staging, target)

    await mkdir(dirname(receiptPath(pack.id)), { recursive: true })
    const receipt: Receipt = {
      id: pack.id,
      version: pack.version,
      installedAt: new Date().toISOString(),
      files: entries.length
    }
    await writeFile(receiptPath(pack.id), JSON.stringify(receipt, null, 2))
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  onProgress?.(1, `${pack.name} installed`)
  return { ...pack, state: packState(pack, pack.version) }
}

/** Remove a pack and its receipt. The library simply has fewer choices after. */
export async function removePack(id: string): Promise<void> {
  if (!isValidPackId(id)) throw new Error(`Refusing to remove an unusable id: ${id}`)
  await rm(join(packRoot(), id), { recursive: true, force: true })
  await rm(receiptPath(id), { force: true }).catch(() => undefined)
}

/**
 * The archive, with progress.
 *
 * Streamed rather than `arrayBuffer()`d so a 150MB pack reports a moving bar
 * instead of sitting at zero and then finishing — which for a download this
 * size reads as the app having hung.
 */
async function download(
  pack: Pack,
  signal: AbortSignal | undefined,
  onProgress: InstallOptions['onProgress']
): Promise<Buffer> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), DOWNLOAD_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal

  try {
    const response = await fetch(pack.url, { signal: combined, redirect: 'follow' })
    if (!response.ok) throw new Error(`${pack.name} could not be fetched (${response.status})`)

    const declared = Number(response.headers.get('content-length'))
    const total = Number.isFinite(declared) && declared > 0 ? declared : pack.bytes
    const chunks: Uint8Array[] = []
    let received = 0

    const reader = response.body?.getReader()
    if (!reader) return Buffer.from(await response.arrayBuffer())

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new CancelledError()
      }
      chunks.push(value)
      received += value.byteLength
      onProgress?.(packProgress(received, total), `fetching ${pack.name}`)
    }
    return Buffer.concat(chunks)
  } catch (err) {
    if (signal?.aborted) throw new CancelledError()
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${pack.name} stopped responding`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
