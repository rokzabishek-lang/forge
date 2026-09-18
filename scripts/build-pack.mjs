#!/usr/bin/env node
/**
 * Build an asset pack: a directory in, a `.tar.gz` and a checksum out.
 *
 *   node scripts/build-pack.mjs assets dist/library.tar.gz
 *
 * Prints the three fields to paste into `BUILT_IN_MANIFEST`. Nothing is
 * fetchable until those are filled in — `isPublished()` hides any pack whose
 * sha256 is empty, on purpose.
 *
 * Three things this does that `tar czf` does not:
 *
 * **It refuses what the installer would refuse.** Member names are checked with
 * the SAME `safeMemberPath` the installer uses, imported from the app rather
 * than reimplemented here. A second copy of that rule would drift, and the
 * failure it drifts into is a pack that builds green and then refuses to
 * install after an 81MB download.
 *
 * **It reads its own output back.** The archive is gunzipped and parsed with
 * the app's own `readTar`, and every member is compared byte for byte against
 * the file on disk, before a checksum anybody might publish is printed.
 *
 * **It is deterministic.** Sorted names, zeroed timestamps and ownership,
 * normalised modes — so rebuilding the same directory gives the same sha256,
 * and a changed checksum means changed content rather than a changed clock.
 */

import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { transform } from 'esbuild'

const BLOCK = 512

/**
 * Load a shared module without a build step.
 *
 * `pack.ts` and `tar.ts` are dependency-free by design, so each transpiles to
 * a standalone module and imports from a data URL. This is the reason the
 * rules here are the app's rules and not a copy of them.
 */
async function loadShared(file) {
  const source = await readFile(new URL(`../src/shared/assets/${file}`, import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

/** Every file under `dir`, relative and with forward slashes, sorted. */
async function walk(dir, base = dir, out = []) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    // The same rule the catalog scanner uses. A .DS_Store in a published pack
    // is noise that every user then downloads.
    if (item.name.startsWith('.')) continue
    const full = join(dir, item.name)
    if (item.isDirectory()) await walk(full, base, out)
    else if (item.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function header({ name, size, mode, type = '0' }) {
  const block = Buffer.alloc(BLOCK)
  const put = (text, at, len) => block.write(text.slice(0, len), at, len, 'utf8')

  put(name, 0, 100)
  put(octal(mode, 8), 100, 8)
  put(octal(0, 8), 108, 8) // uid
  put(octal(0, 8), 116, 8) // gid
  put(octal(size, 12), 124, 12)
  put(octal(0, 12), 136, 12) // mtime — zeroed, so the build is reproducible
  block.write('        ', 148, 8, 'utf8') // checksum field reads as spaces
  block.write(type, 156, 1, 'utf8')
  put('ustar\0', 257, 6)
  put('00', 263, 2)

  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += block[i]
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return block
}

function padded(buffer) {
  const remainder = buffer.length % BLOCK
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder)])
}

/**
 * One member, as its blocks.
 *
 * Names over 100 bytes get a GNU long-name record, which the app's reader
 * understands; the ustar prefix split cannot express every path and silently
 * mangles the ones it cannot.
 *
 * Directory entries are not written at all: the installer creates each file's
 * parent as it goes, so they would carry nothing and add a member kind that
 * could go wrong.
 */
function member(name, body, executable) {
  const nameBytes = Buffer.byteLength(name, 'utf8')
  const blocks = []
  if (nameBytes > 100) {
    const longName = Buffer.from(`${name}\0`, 'utf8')
    blocks.push(
      header({ name: '././@LongLink', size: longName.length, mode: 0o644, type: 'L' }),
      padded(longName)
    )
  }
  blocks.push(
    header({ name, size: body.length, mode: executable ? 0o755 : 0o644 }),
    padded(body)
  )
  return blocks
}

async function main() {
  const [source, output] = process.argv.slice(2)
  if (!source || !output) {
    console.error('usage: node scripts/build-pack.mjs <source-dir> <out.tar.gz>')
    process.exit(1)
  }

  const { safeMemberPath, formatBytes } = await loadShared('pack.ts')
  const { readTar } = await loadShared('tar.ts')

  const root = resolve(source)
  const names = await walk(root)
  if (names.length === 0) {
    console.error(`${root} has no files in it`)
    process.exit(1)
  }

  // Before anything is read, let alone written: a name the installer would
  // refuse is a pack that cannot be installed, and it should fail here.
  const refused = names.filter((name) => safeMemberPath(name) === null)
  if (refused.length > 0) {
    console.error(`${refused.length} file(s) cannot go in a pack:\n`)
    for (const name of refused.slice(0, 20)) console.error(`  ${name}`)
    if (refused.length > 20) console.error(`  … and ${refused.length - 20} more`)
    console.error('\nWindows forbids < > : " | ? * and trailing dots or spaces.')
    process.exit(1)
  }

  const blocks = []
  const bodies = new Map()
  let unpacked = 0
  for (const name of names) {
    const body = await readFile(join(root, name))
    const mode = (await stat(join(root, name))).mode
    bodies.set(name, body)
    unpacked += body.length
    blocks.push(...member(name, body, (mode & 0o111) !== 0))
  }
  blocks.push(Buffer.alloc(BLOCK * 2)) // two zero blocks end the archive

  const tar = Buffer.concat(blocks)
  const archive = gzipSync(tar, { level: 9 })

  /* ------------------------------------------------------- verification */

  const entries = readTar(new Uint8Array(gunzipSync(archive)), safeMemberPath)
  if (entries.length !== names.length) {
    console.error(`read back ${entries.length} members, wrote ${names.length}`)
    process.exit(1)
  }
  for (const entry of entries) {
    const expected = bodies.get(entry.name)
    if (!expected) {
      console.error(`read back a member that was never written: ${entry.name}`)
      process.exit(1)
    }
    const actual = Buffer.from(tar.subarray(entry.offset, entry.offset + entry.size))
    if (!actual.equals(expected)) {
      console.error(`${entry.name} did not survive the round trip`)
      process.exit(1)
    }
  }

  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(output, archive)
  const sha256 = createHash('sha256').update(archive).digest('hex')

  console.log(`\n${output}`)
  console.log(`  files       ${names.length}`)
  console.log(`  unpacked    ${formatBytes(unpacked)}`)
  console.log(`  compressed  ${formatBytes(archive.length)}  (${archive.length} bytes)`)
  console.log(`  sha256      ${sha256}`)
  console.log(`  verified    read back and compared byte for byte\n`)
  console.log('Paste into BUILT_IN_MANIFEST in src/shared/assets/pack.ts:\n')
  console.log(`      sha256: '${sha256}',`)
  console.log(`      bytes: ${archive.length}\n`)
}

await main()
