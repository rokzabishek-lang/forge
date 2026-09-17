/**
 * Where yt-dlp comes from.
 *
 * It is fetched on first use rather than bundled, and the reason is that
 * yt-dlp ROTS. YouTube changes something every few weeks and a pinned copy
 * stops working until the next app release — for a tool whose entire job is
 * keeping up with a site that changes on purpose. Fetching the current release
 * into the app's own data directory keeps the installer small and lets a stale
 * copy be replaced without shipping anything.
 *
 * The same precedent already exists here: the depth model and Kokoro's voice
 * files are fetched on first use into the cache, not bundled.
 *
 * This file is the PURE half — which asset for which platform, the URLs, and
 * how to read the published checksums — so all of it is testable with no
 * network and no electron. The download itself is in src/main/ingest/binary.ts.
 */

export type ReleasePlatform = 'darwin' | 'win32' | 'linux'

const OWNER_REPO = 'yt-dlp/yt-dlp'

/**
 * The release asset for a platform.
 *
 * `yt-dlp_macos` is a universal binary and covers Apple Silicon and Intel in
 * one file. Windows gets the x64 exe; there is no arm64 Windows build worth
 * depending on. Linux gets the x86_64 build, and anything else is refused
 * rather than guessed — a wrong binary that fails to start is a worse first
 * experience than a clear message.
 */
export function releaseAsset(platform: string, arch: string): string | null {
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'yt-dlp.exe' : null
  if (platform === 'linux') return arch === 'x64' ? 'yt-dlp_linux' : null
  return null
}

/** What the binary is called once it lives in our directory. */
export function installedName(platform: string): string {
  return platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
}

/**
 * GitHub's stable "latest release" redirect. It answers 302 to the real asset,
 * so the version does not have to be known in advance — which is the point.
 */
export function releaseUrl(asset: string): string {
  return `https://github.com/${OWNER_REPO}/releases/latest/download/${asset}`
}

/** yt-dlp publishes this beside every release. */
export const CHECKSUMS_ASSET = 'SHA2-256SUMS'

/**
 * Parse the checksum file: one `<sha256>  <filename>` per line.
 *
 * Tolerant of blank lines, CRLF, and a single or double space, because the
 * file's exact whitespace is not something worth failing an install over.
 * Strict about the hash itself: 64 hex characters or the line is ignored.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(raw)
    if (match) sums.set(match[2], match[1].toLowerCase())
  }
  return sums
}

/**
 * The error a user sees when the fetch fails, with the way out spelled out.
 *
 * Both fallbacks are read by `ensureYtDlp`: an explicit path in `FORGE_YTDLP`,
 * or a `yt-dlp` already on PATH. Saying so is what turns a dead end into a
 * two-minute detour.
 */
export function fetchFailureMessage(reason: string): string {
  return (
    `Downloads need yt-dlp, and it could not be fetched: ${reason}\n\n` +
    `If this machine is offline, install yt-dlp yourself and either put it on ` +
    `your PATH or point FORGE_YTDLP at it.`
  )
}
