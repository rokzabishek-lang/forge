/**
 * Reading a tar archive, in pure TypeScript.
 *
 * Packs are `.tar.gz` rather than `.zip` for one reason: Node can gunzip with
 * `node:zlib` and tar's format is simple enough to parse here, so installing a
 * pack needs no native dependency, no bundled binary and no `tar` on the user's
 * PATH. A zip would have meant adding one of those three, and every one of them
 * is a thing that can be missing on a machine we cannot see — which this project
 * has now spent a day learning about.
 *
 * It also means the parsing is PURE, so the member-path safety and the header
 * arithmetic are tested without writing a single file to disk.
 *
 * Only what a pack actually contains is supported: regular files and
 * directories, plus GNU long names. Symlinks, hard links, devices and sparse
 * files are refused rather than ignored — a pack containing one is not a pack
 * we made, and quietly skipping it would be the wrong answer to that.
 */

export interface TarEntry {
  /** The member's path inside the archive, already checked for safety. */
  name: string
  /** Byte offset of the member's contents within the tar buffer. */
  offset: number
  size: number
  /** Unix mode bits, for restoring the executable bit where it matters. */
  mode: number
}

const BLOCK = 512

/**
 * A NUL-terminated header field, read verbatim.
 *
 * Deliberately NOT trimmed. Tar NUL-pads names and space-pads only its numeric
 * fields, so trimming here would silently rewrite a member called `report.txt `
 * into `report.txt` — turning a name Windows cannot create into one it can,
 * and writing a file the archive did not describe. `safeMemberPath` must be the
 * thing that refuses it, which it cannot do if this has already tidied it away.
 */
function str(buffer: Uint8Array, start: number, length: number): string {
  let end = start
  const limit = start + length
  while (end < limit && buffer[end] !== 0) end++
  return new TextDecoder().decode(buffer.subarray(start, end))
}

/** Sizes and modes are octal ASCII, space- or NUL-padded. */
function octal(buffer: Uint8Array, start: number, length: number): number {
  const text = str(buffer, start, length).replace(/[^0-7]/g, '')
  if (!text) return 0
  const value = parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * The header checksum, which is what tells a real header from padding.
 *
 * Computed with the checksum field itself read as eight spaces — that is the
 * spec, and getting it wrong means every header looks corrupt. Both the signed
 * and unsigned sums are accepted because historic writers disagreed about
 * whether the bytes were signed, and some archives in the wild use each.
 */
function checksumMatches(header: Uint8Array): boolean {
  const stored = octal(header, 148, 8)
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  return stored === unsigned || stored === signed
}

export class TarError extends Error {}

/**
 * Every file in the archive, with where its bytes are.
 *
 * Returns offsets rather than copies so a 150MB pack is walked without being
 * duplicated in memory.
 *
 * `isSafe` decides which member paths are allowed. It is injected rather than
 * imported so this file stays free of any policy — the caller owns that, and
 * `safeMemberPath` in pack.ts is what it passes.
 */
export function readTar(buffer: Uint8Array, isSafe: (name: string) => string | null): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  /** GNU long name, when the previous header was an 'L' record. */
  let pendingName: string | null = null

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)

    // Two consecutive zero blocks end the archive; one is padding.
    if (header.every((byte) => byte === 0)) {
      offset += BLOCK
      continue
    }
    if (!checksumMatches(header)) {
      throw new TarError(`Corrupt tar header at byte ${offset}`)
    }

    const rawName = pendingName ?? str(header, 0, 100)
    const prefix = str(header, 345, 155)
    const name = pendingName === null && prefix ? `${prefix}/${rawName}` : rawName
    pendingName = null

    const size = octal(header, 124, 12)
    const mode = octal(header, 100, 8)
    const type = String.fromCharCode(header[156] || 0x30)
    const dataAt = offset + BLOCK
    // Contents are padded to a block boundary.
    const advance = BLOCK + Math.ceil(size / BLOCK) * BLOCK

    if (dataAt + size > buffer.length) {
      throw new TarError(`Truncated tar: ${name} claims ${size} bytes past the end`)
    }

    if (type === 'L') {
      // GNU long name: this record's CONTENTS are the next member's path.
      pendingName = new TextDecoder().decode(buffer.subarray(dataAt, dataAt + size)).replace(/\0+$/, '')
      offset += advance
      continue
    }

    if (type === '0' || type === '\0') {
      const safe = isSafe(name)
      if (safe === null) {
        throw new TarError(`Refusing a tar member that escapes its directory: ${name}`)
      }
      entries.push({ name: safe, offset: dataAt, size, mode })
    } else if (type === '5' || type === 'x' || type === 'g') {
      // Directory, or a pax header we do not need — both carry nothing to write.
    } else {
      // A symlink, hard link or device node. Not something our packs contain,
      // and following one is how an archive writes outside its directory.
      throw new TarError(`Unsupported tar entry type '${type}' for ${name}`)
    }

    offset += advance
  }

  return entries
}
