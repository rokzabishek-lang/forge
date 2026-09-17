import { describe, it, expect } from 'vitest'
import {
  CHECKSUMS_ASSET,
  fetchFailureMessage,
  installedName,
  parseChecksums,
  releaseAsset,
  releaseUrl
} from '@shared/ingest/release'

describe('which yt-dlp to fetch', () => {
  it('picks one universal binary for every Mac', () => {
    expect(releaseAsset('darwin', 'arm64')).toBe('yt-dlp_macos')
    expect(releaseAsset('darwin', 'x64')).toBe('yt-dlp_macos')
  })

  it('picks the exe on Windows', () => {
    expect(releaseAsset('win32', 'x64')).toBe('yt-dlp.exe')
  })

  it('refuses rather than guesses for a platform with no build', () => {
    // A wrong binary that fails to start is a worse first experience than a
    // clear message saying there is none.
    expect(releaseAsset('freebsd', 'x64')).toBeNull()
    expect(releaseAsset('linux', 'ia32')).toBeNull()
    expect(releaseAsset('win32', 'ia32')).toBeNull()
  })

  it('installs under the name the platform expects', () => {
    expect(installedName('win32')).toBe('yt-dlp.exe')
    expect(installedName('darwin')).toBe('yt-dlp')
    expect(installedName('linux')).toBe('yt-dlp')
  })

  it('uses the latest-release redirect so no version is pinned', () => {
    const url = releaseUrl('yt-dlp_macos')
    expect(url).toBe('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos')
    expect(url).not.toMatch(/\d{4}\.\d{2}\.\d{2}/)
  })
})

describe('reading the published checksums', () => {
  const HASH_A = 'a'.repeat(64)
  const HASH_B = 'B'.repeat(64)

  it('reads the two-space format yt-dlp publishes', () => {
    const sums = parseChecksums(`${HASH_A}  yt-dlp_macos\n${HASH_B}  yt-dlp.exe\n`)
    expect(sums.get('yt-dlp_macos')).toBe(HASH_A)
    expect(sums.get('yt-dlp.exe')).toBe(HASH_B.toLowerCase())
  })

  it('tolerates CRLF, a single space, a binary-mode star and blank lines', () => {
    const sums = parseChecksums(`\r\n${HASH_A} yt-dlp_macos\r\n${HASH_B}  *yt-dlp.exe\r\n\r\n`)
    expect(sums.get('yt-dlp_macos')).toBe(HASH_A)
    expect(sums.get('yt-dlp.exe')).toBe(HASH_B.toLowerCase())
  })

  it('ignores anything that is not a 64-character hex hash', () => {
    // Strict about the hash: this is what an executable is trusted against.
    const sums = parseChecksums(
      `deadbeef  short.bin\n${'g'.repeat(64)}  nothex.bin\n# a comment\n${HASH_A}  real.bin`
    )
    expect(sums.size).toBe(1)
    expect(sums.get('real.bin')).toBe(HASH_A)
  })

  it('names the checksum asset yt-dlp actually ships', () => {
    expect(CHECKSUMS_ASSET).toBe('SHA2-256SUMS')
  })
})

describe('when the fetch fails', () => {
  it('tells the user both ways out', () => {
    const message = fetchFailureMessage('the network is unreachable')
    expect(message).toContain('the network is unreachable')
    expect(message).toContain('FORGE_YTDLP')
    expect(message).toContain('PATH')
  })
})
