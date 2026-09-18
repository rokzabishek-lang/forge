import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  BUILT_IN_MANIFEST,
  formatBytes,
  isPublished,
  isValidPackId,
  MANIFEST_VERSION,
  mergeManifest,
  packProgress,
  packState,
  safeMemberPath,
  type Pack
} from '@shared/assets/pack'
import { readTar, TarError } from '@shared/assets/tar'

const PACK: Pack = {
  id: 'library',
  name: 'Asset library',
  summary: 'fonts, transitions, titles',
  group: 'library',
  version: 2,
  url: 'https://example.com/library.tar.gz',
  sha256: 'a'.repeat(64),
  bytes: 85_000_000
}

/* ------------------------------------------------------------------ tar */

/** Build a real tar in memory, so the reader is tested against the format. */
function tarOf(files: { name: string; body: string; mode?: number; type?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const file of files) {
    const header = new Uint8Array(512)
    const put = (text: string, at: number, len: number): void => {
      const bytes = new TextEncoder().encode(text)
      header.set(bytes.subarray(0, len), at)
    }
    put(file.name, 0, 100)
    put((file.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 8)
    put('0000000', 108, 8)
    put('0000000', 116, 8)
    const body = new TextEncoder().encode(file.body)
    put(body.length.toString(8).padStart(11, '0'), 124, 12)
    put('00000000000', 136, 12)
    header[156] = (file.type ?? '0').charCodeAt(0)
    put('ustar  ', 257, 8)
    // Checksum, computed with the field read as spaces.
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)

    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
    padded.set(body)
    if (padded.length > 0) blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024)) // two zero blocks end the archive
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const b of blocks) {
    out.set(b, at)
    at += b.length
  }
  return out
}

const read = (buf: Uint8Array) => readTar(buf, safeMemberPath)

describe('reading a tar', () => {
  it('finds every file, with its bytes where it says they are', () => {
    const tar = tarOf([
      { name: 'fonts/Inter.ttf', body: 'FONTDATA' },
      { name: 'sfx/whoosh.wav', body: 'RIFFxxxx' }
    ])
    const entries = read(tar)
    expect(entries.map((e) => e.name)).toEqual(['fonts/Inter.ttf', 'sfx/whoosh.wav'])
    expect(entries[0].size).toBe(8)
    expect(new TextDecoder().decode(tar.subarray(entries[0].offset, entries[0].offset + 8))).toBe(
      'FONTDATA'
    )
    expect(new TextDecoder().decode(tar.subarray(entries[1].offset, entries[1].offset + 8))).toBe(
      'RIFFxxxx'
    )
  })

  it('survives a round trip through gzip, which is how packs ship', () => {
    const tar = tarOf([{ name: 'a/b.txt', body: 'hello' }])
    const { gunzipSync } = require('node:zlib') as typeof import('node:zlib')
    const back = new Uint8Array(gunzipSync(gzipSync(Buffer.from(tar))))
    expect(read(back).map((e) => e.name)).toEqual(['a/b.txt'])
  })

  it('skips directories, which carry no bytes', () => {
    const tar = tarOf([
      { name: 'fonts/', body: '', type: '5' },
      { name: 'fonts/Inter.ttf', body: 'X' }
    ])
    expect(read(tar).map((e) => e.name)).toEqual(['fonts/Inter.ttf'])
  })

  it('keeps the executable bit only where it was set', () => {
    const tar = tarOf([
      { name: 'bin/tool', body: 'X', mode: 0o755 },
      { name: 'data.bin', body: 'X', mode: 0o644 }
    ])
    const [exe, data] = read(tar)
    expect(exe.mode & 0o111).not.toBe(0)
    expect(data.mode & 0o111).toBe(0)
  })

  it('REFUSES a member that escapes its directory', () => {
    /*
     * The oldest bug in archive handling. A pack is untrusted input even when
     * we publish it — a truncated or altered archive is exactly the case the
     * checksum exists for, and this is the second line of defence.
     */
    for (const name of [
      '../outside.txt',
      'a/../../outside.txt',
      '/etc/passwd',
      'C:/Windows/system32/x.dll',
      '\\\\server\\share\\x',
      'a\\b.txt'
    ]) {
      expect(() => read(tarOf([{ name, body: 'X' }])), name).toThrow(TarError)
    }
  })

  it('REFUSES a symlink rather than ignoring it', () => {
    // Following one is another way to write outside the directory, and our
    // packs contain none — so its presence means something is wrong.
    expect(() => read(tarOf([{ name: 'link', body: '', type: '2' }]))).toThrow(/Unsupported/)
  })

  it('refuses a name Windows cannot create', () => {
    // The rule that has already cost this project two red CI runs.
    // A trailing space or dot on a COMPONENT, not one in the middle:
    // `trailing .txt` is perfectly legal there and must stay allowed.
    expect(() => read(tarOf([{ name: 'a/trailing .txt', body: 'X' }]))).not.toThrow()
    for (const name of ['a/b:c.txt', 'a/what?.png', 'a/pipe|d.wav', 'a/ends.txt ', 'a/ends.', 'a/dir /b.txt']) {
      expect(() => read(tarOf([{ name, body: 'X' }])), name).toThrow(TarError)
    }
  })

  it('refuses traversal on its own merits, not because of the Windows rule', () => {
    /*
     * A mutation check showed that deleting the `..` test changed nothing:
     * `..` ends in a dot, so the Windows trailing-dot rule caught it anyway.
     * The two overlap by accident, and this asserts the traversal rule
     * directly so relaxing the platform rule some day cannot quietly remove
     * the safety one.
     */
    expect(safeMemberPath('../x')).toBeNull()
    expect(safeMemberPath('a/../../x')).toBeNull()
    expect(safeMemberPath('a//b.txt')).toBeNull()
    // And the things that must still be allowed.
    expect(safeMemberPath('fonts/Inter.ttf')).toBe('fonts/Inter.ttf')
    expect(safeMemberPath('a/b/c/d.wav')).toBe('a/b/c/d.wav')
    expect(safeMemberPath('sticker..name.mp4')).toBe('sticker..name.mp4')
  })

  it('refuses a corrupt header rather than reading garbage', () => {
    const tar = tarOf([{ name: 'a.txt', body: 'X' }])
    tar[150] = 0x39 // break the stored checksum
    expect(() => read(tar)).toThrow(/Corrupt tar header/)
  })

  it('refuses an archive that claims more bytes than it has', () => {
    const tar = tarOf([{ name: 'a.txt', body: 'X' }])
    // Rewrite the size field to 100MB and recompute the checksum so the header
    // itself is valid — the truncation is the only thing wrong.
    const put = (text: string, at: number, len: number): void =>
      tar.set(new TextEncoder().encode(text).subarray(0, len), at)
    put((100_000_000).toString(8).padStart(11, '0'), 124, 12)
    for (let i = 148; i < 156; i++) tar[i] = 0x20
    let sum = 0
    for (let i = 0; i < 512; i++) sum += tar[i]
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    expect(() => read(tar)).toThrow(/Truncated/)
  })

  it('reads an empty archive as nothing, not as an error', () => {
    expect(read(tarOf([]))).toEqual([])
  })
})

/* ------------------------------------------------------------- manifest */

describe('which packs exist', () => {
  it('hides a pack with no published checksum', () => {
    /*
     * A "Get the asset library" button that 404s makes a working app look
     * broken. Entries live in the manifest before their release is cut, and
     * this is what keeps them off the screen until they are real.
     */
    expect(isPublished({ ...PACK, sha256: '' })).toBe(false)
    expect(isPublished({ ...PACK, sha256: 'nothex' })).toBe(false)
    expect(isPublished({ ...PACK, url: 'http://example.com/x.tar.gz' })).toBe(false)
    expect(isPublished(PACK)).toBe(true)
  })

  it('reports the built-in library pack as unpublished for now', () => {
    const library = BUILT_IN_MANIFEST.packs.find((p) => p.id === 'library')!
    expect(packState(library, null).kind).toBe('unpublished')
  })

  it('knows installed from stale from available', () => {
    expect(packState(PACK, null)).toEqual({ kind: 'available' })
    expect(packState(PACK, 1)).toEqual({ kind: 'stale', installed: 1 })
    expect(packState(PACK, 2)).toEqual({ kind: 'installed', version: 2 })
    // A newer pack than the manifest knows about is not stale.
    expect(packState(PACK, 3)).toEqual({ kind: 'installed', version: 3 })
  })

  it('only allows a pack id that is safe as a directory name', () => {
    for (const ok of ['library', 'stickers-telugu', 'a', 'x1-2-3']) {
      expect(isValidPackId(ok), ok).toBe(true)
    }
    for (const bad of ['', 'Library', 'a/b', '../x', 'a:b', '-lead', 'a'.repeat(49), 'a b']) {
      expect(isValidPackId(bad), bad).toBe(false)
    }
  })
})

describe('layering a fetched manifest over the built-in one', () => {
  const remote = (packs: unknown[]): unknown => ({ manifestVersion: MANIFEST_VERSION, packs })

  it('adds packs the build did not ship knowing about', () => {
    const extra = { ...PACK, id: 'stickers-telugu', group: 'stickers' as const }
    const { packs, usedRemote } = mergeManifest(BUILT_IN_MANIFEST, remote([extra]))
    expect(usedRemote).toBe(true)
    expect(packs.map((p) => p.id)).toContain('stickers-telugu')
    expect(packs.map((p) => p.id)).toContain('library')
  })

  it('replaces a known pack, so a re-cut release reaches old builds', () => {
    const { packs } = mergeManifest(BUILT_IN_MANIFEST, remote([{ ...PACK, version: 9 }]))
    expect(packs.find((p) => p.id === 'library')?.version).toBe(9)
  })

  it('ignores a malformed remote entirely rather than trusting part of it', () => {
    for (const bad of [null, undefined, 'nonsense', {}, { manifestVersion: 99, packs: [] }]) {
      const { packs, usedRemote } = mergeManifest(BUILT_IN_MANIFEST, bad)
      expect(usedRemote, JSON.stringify(bad)).toBe(false)
      expect(packs).toEqual(BUILT_IN_MANIFEST.packs)
    }
  })

  it('drops a bad entry without letting it remove a good built-in one', () => {
    /*
     * A remote list is untrusted input even when we publish it. The failure to
     * avoid is a malformed entry knocking out a pack that works.
     */
    const { packs } = mergeManifest(
      BUILT_IN_MANIFEST,
      remote([{ ...PACK, id: '../escape' }, { ...PACK, url: 'http://insecure' }, { id: 'x' }])
    )
    expect(packs.map((p) => p.id)).toEqual(['library'])
  })
})

describe('what the button says', () => {
  it('reports progress only when a total is known', () => {
    expect(packProgress(0, 100)).toBe(0)
    expect(packProgress(50, 100)).toBe(0.5)
    expect(packProgress(150, 100)).toBe(1)
    // Null, not zero: a bar stuck at the left is a lie about a live download.
    expect(packProgress(50, null)).toBeNull()
    expect(packProgress(50, 0)).toBeNull()
  })

  it('formats a size the way a person reads one', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(85_000_000)).toBe('81 MB')
    expect(formatBytes(1_400_000_000)).toBe('1.3 GB')
  })
})
