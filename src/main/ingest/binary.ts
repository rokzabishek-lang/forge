import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { app } from 'electron'
import {
  CHECKSUMS_ASSET,
  fetchFailureMessage,
  installedName,
  parseChecksums,
  releaseAsset,
  releaseUrl
} from '@shared/ingest/release'

/**
 * Finding, or fetching, yt-dlp.
 *
 * Three places it can come from, in this order:
 *
 *   1. `FORGE_YTDLP`   an explicit path — for development, and for anyone whose
 *                      machine cannot reach GitHub
 *   2. our own copy    `<userData>/tools/yt-dlp`, fetched on first use
 *   3. PATH            a copy the user already has, if we have none yet
 *
 * The managed copy sits above PATH because it is the one we can replace when
 * yt-dlp goes stale, which it does every few weeks. PATH is the fallback that
 * saves a download, not the preferred source.
 *
 * Every fetch is verified against the checksums yt-dlp publishes beside each
 * release. This is an executable being downloaded and run; nothing about that
 * is acceptable on trust.
 */

export type YtDlpSource = 'env' | 'managed' | 'path'

export interface YtDlpTool {
  path: string
  source: YtDlpSource
  /** As reported by `--version`, e.g. `2026.08.19`. Null if it would not say. */
  version: string | null
}

export interface YtDlpStatus {
  ready: boolean
  tool: YtDlpTool | null
  /** Why not, when not — written for the screen. */
  reason: string | null
}

const VERSION_TIMEOUT_MS = 15_000
const CHECKSUMS_TIMEOUT_MS = 60_000
/** ~30MB on a slow connection. */
const BINARY_TIMEOUT_MS = 5 * 60_000

function toolsDir(): string {
  return join(app.getPath('userData'), 'tools')
}

function managedPath(): string {
  return join(toolsDir(), installedName(process.platform))
}

function manifestPath(): string {
  return join(toolsDir(), 'yt-dlp.json')
}

async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `--version`, or null if the binary will not run.
 *
 * Doubles as the health check: a truncated download, a wrong-architecture
 * binary and a missing runtime library all fail here, before a user has typed
 * a URL. On Windows this is also where a missing Visual C++ runtime would show,
 * which is exactly the sort of first-run fault a clean machine exists to find.
 */
export function ytDlpVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      path,
      ['--version'],
      { windowsHide: true, timeout: VERSION_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null)
        const version = String(stdout).trim().split(/\r?\n/)[0]
        resolve(version || null)
      }
    )
  })
}

async function onPath(): Promise<string | null> {
  const name = installedName(process.platform)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (await runnable(candidate)) return candidate
  }
  return null
}

/** Where yt-dlp is right now, without fetching anything. */
export async function locateYtDlp(): Promise<YtDlpTool | null> {
  const explicit = process.env.FORGE_YTDLP
  if (explicit && (await runnable(explicit))) {
    return { path: explicit, source: 'env', version: await ytDlpVersion(explicit) }
  }

  const managed = managedPath()
  if (await runnable(managed)) {
    const version = await ytDlpVersion(managed)
    // A managed copy that will not run is a broken download, not a tool. Fall
    // through so it is re-fetched rather than reported as ready.
    if (version) return { path: managed, source: 'managed', version }
  }

  const found = await onPath()
  if (found) return { path: found, source: 'path', version: await ytDlpVersion(found) }

  return null
}

export async function ytDlpStatus(): Promise<YtDlpStatus> {
  const tool = await locateYtDlp()
  if (tool) return { ready: true, tool, reason: null }
  return {
    ready: false,
    tool: null,
    reason: 'yt-dlp is not on this machine yet. It downloads the first time a link is pasted.'
  }
}

async function get(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${url} did not answer within ${Math.round(timeoutMs / 1000)}s`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the current release into our directory, verified.
 *
 * Written to a temporary name and renamed into place, so a half-finished
 * download is never mistaken for a binary. The checksum file is fetched FIRST:
 * if it is unreachable or does not list our asset, nothing is downloaded at all.
 */
async function fetchYtDlp(onMessage?: (message: string) => void): Promise<YtDlpTool> {
  const asset = releaseAsset(process.platform, process.arch)
  if (!asset) {
    throw new Error(`There is no yt-dlp build for ${process.platform}/${process.arch}`)
  }

  try {
    await mkdir(toolsDir(), { recursive: true })

    onMessage?.('checking the yt-dlp release')
    const sums = parseChecksums(await (await get(releaseUrl(CHECKSUMS_ASSET), CHECKSUMS_TIMEOUT_MS)).text())
    const expected = sums.get(asset)
    if (!expected) throw new Error(`the release does not publish a checksum for ${asset}`)

    onMessage?.('downloading yt-dlp (~30MB, first time only)')
    const bytes = Buffer.from(await (await get(releaseUrl(asset), BINARY_TIMEOUT_MS)).arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('the download was empty')

    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new Error(`the download did not match its published checksum (${actual.slice(0, 12)}… vs ${expected.slice(0, 12)}…)`)
    }

    const final = managedPath()
    const temp = `${final}.download`
    await writeFile(temp, bytes)
    if (process.platform !== 'win32') await chmod(temp, 0o755)
    await rename(temp, final)

    const version = await ytDlpVersion(final)
    if (!version) {
      throw new Error(
        process.platform === 'win32'
          ? 'yt-dlp downloaded but would not start. On Windows this usually means the Visual C++ runtime is missing.'
          : 'yt-dlp downloaded but would not start'
      )
    }

    await writeFile(
      manifestPath(),
      JSON.stringify({ version, asset, fetchedAt: new Date().toISOString() }, null, 2)
    )
    return { path: final, source: 'managed', version }
  } catch (err) {
    throw new Error(fetchFailureMessage(err instanceof Error ? err.message : String(err)))
  }
}

/**
 * The tool, fetching it if this machine has none.
 *
 * `refresh` forces a fresh fetch of the current release over whatever is there,
 * which is the whole answer to "YouTube changed and downloads broke".
 */
export async function ensureYtDlp(
  onMessage?: (message: string) => void,
  options: { refresh?: boolean } = {}
): Promise<YtDlpTool> {
  if (!options.refresh) {
    const found = await locateYtDlp()
    if (found) return found
  }
  return fetchYtDlp(onMessage)
}

/** What the last fetch recorded, for a settings screen. Null if never fetched. */
export async function ytDlpManifest(): Promise<{ version: string; asset: string; fetchedAt: string } | null> {
  try {
    return JSON.parse(await readFile(manifestPath(), 'utf8'))
  } catch {
    return null
  }
}
