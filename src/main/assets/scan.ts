import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, extname, basename, dirname, isAbsolute } from 'node:path'
import { app } from 'electron'
import {
  CATALOG_VERSION,
  charFromCodepoints,
  codepointsFromStickerFile,
  fontFamilyFromFilename,
  fontSourceFor,
  isRestrictedFontFile,
  type AssetCatalog,
  type CatalogEntry
} from '@shared/assets/catalog'

/**
 * Folder names accepted for each kind.
 *
 * Real asset libraries do not agree on naming — the same set has arrived as
 * `sfx` and `sfxx`, and as `stickers/color` and plain `color`. Matching a list
 * of aliases rather than one exact name means a library can be dropped in
 * without being reorganised first, and §summary reports what was actually
 * found so a miss is visible instead of silent.
 */
const KIND_DIRS: Record<string, string[]> = {
  font: ['fonts', 'font'],
  sfx: ['sfx', 'sfxx', 'sounds', 'audio'],
  sticker: ['stickers', 'color', 'emoji'],
  prop: ['props_3d', 'props3d', 'props'],
  title: ['titles', 'title'],
  transition: ['transitions', 'transition']
}

/** The folder names that mean a KIND, so a pack's folder is not mistaken for one. */
const KIND_DIR_NAMES = new Set(Object.values(KIND_DIRS).flat())

/**
 * The directories installed packs own, one level under the root.
 *
 * `installPack` writes each pack into `<root>/<pack.id>/`, so its fonts land in
 * `<root>/library/fonts` and not `<root>/fonts`. Scanning only the root found
 * none of them: the download succeeded, the files were on disk, the receipt was
 * written, and the Library said "Nothing here." — which is this project's
 * signature failure, everything green and nothing visible.
 *
 * Unioning them is also what makes categories work at all. Two sticker packs
 * both contain `stickers/`, and the catalog is meant to be both.
 */
async function packDirs(root: string): Promise<string[]> {
  let items
  try {
    items = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return items
    .filter(
      (item) =>
        item.isDirectory() &&
        // `.packs` and any in-progress staging directory; the same rule `walk`
        // uses, which is why staging is named with a leading dot.
        !item.name.startsWith('.') &&
        // A hand-placed library's own `fonts/` is not a pack.
        !KIND_DIR_NAMES.has(item.name)
    )
    .map((item) => join(root, item.name))
}

/** Every existing directory for a kind; a library may split one across several. */
async function dirsFor(root: string, kind: string): Promise<string[]> {
  const aliases = KIND_DIRS[kind] ?? []
  const found: string[] = []
  // The root itself first — a hand-placed folder, or FORGE_ASSETS_DIR — then
  // each installed pack.
  for (const base of [root, ...(await packDirs(root))]) {
    for (const name of aliases) {
      const dir = join(base, name)
      try {
        if ((await stat(dir)).isDirectory()) found.push(dir)
      } catch {
        // Not present under this alias.
      }
    }
  }
  return found
}

async function walkKind(root: string, kind: string): Promise<string[]> {
  const files: string[] = []
  for (const dir of await dirsFor(root, kind)) await walk(dir, files)
  return files
}

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aac', '.m4a', '.ogg', '.flac'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    if (item.name.startsWith('.')) continue
    const full = join(dir, item.name)
    if (item.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

async function titleMeta(file: string): Promise<{ width: number; height: number; textSlots: number }> {
  try {
    const svg = await readFile(file, 'utf8')
    return {
      width: Math.round(Number(svg.match(/\swidth="(\d+(?:\.\d+)?)"/)?.[1] ?? 0)),
      height: Math.round(Number(svg.match(/\sheight="(\d+(?:\.\d+)?)"/)?.[1] ?? 0)),
      textSlots: (svg.match(/<text[\s>]/g) ?? []).length
    }
  } catch {
    return { width: 0, height: 0, textSlots: 0 }
  }
}

/**
 * Where the asset library lives.
 *
 * Placement is still an open decision, so this resolves by preference and the
 * app degrades gracefully when nothing is found — an empty catalog means fewer
 * choices in the UI, never a failure to start.
 */
/**
 * Where the library is, in order of preference.
 *
 * `FORGE_ASSETS_DIR` first: someone who pointed it at their own folder meant
 * it, and nothing should override that.
 *
 * Then INSTALLED PACKS, under `userData`. They have to live there rather than
 * beside the app because the install directory is inside the bundle on macOS
 * and under `%LOCALAPPDATA%\Programs` on Windows — writing there means an
 * update silently deletes everything the user downloaded.
 *
 * Then whatever shipped with the build, which in practice is nothing: `assets/`
 * is gitignored, so a CI-built installer has none (docs/PACKAGING.md). This
 * branch is what a development checkout uses.
 *
 * Resolved synchronously from a flag, because it is read on nearly every
 * catalog call and an await on each would be silly. `refreshPacksInstalled()`
 * in `./packs` is what does the disk check and sets it — at startup, and after
 * every install and removal.
 */
let packsInstalled = false

export function setPacksInstalled(value: boolean): void {
  packsInstalled = value
}

export function assetsRoot(): string {
  if (process.env.FORGE_ASSETS_DIR) return process.env.FORGE_ASSETS_DIR
  if (packsInstalled) return join(app.getPath('userData'), 'assets')
  return app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(app.getAppPath(), 'assets')
}

export async function scanAssets(root = assetsRoot()): Promise<AssetCatalog> {
  const entries: CatalogEntry[] = []
  const rel = (file: string): string => relative(root, file).split('\\').join('/')

  for (const file of await walkKind(root, 'font')) {
    if (!FONT_EXT.has(extname(file).toLowerCase())) continue
    const filename = basename(file)
    const family = fontFamilyFromFilename(filename)
    const source = fontSourceFor(family)
    const restricted = isRestrictedFontFile(filename)
    entries.push({
      id: `font:${slugify(filename)}`,
      kind: 'font',
      name: family,
      file: rel(file),
      tags: [family, source, ...(restricted ? ['restricted'] : [])],
      meta: { family, source, ...(restricted ? { restricted: true } : {}) }
    })
  }

  for (const file of await walkKind(root, 'sfx')) {
    if (!AUDIO_EXT.has(extname(file).toLowerCase())) continue
    const filename = basename(file)
    const name = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
    entries.push({
      id: `sfx:${slugify(filename)}`,
      kind: 'sfx',
      name,
      file: rel(file),
      tags: name.split(' '),
      meta: { durationMs: null }
    })
  }

  for (const file of await walkKind(root, 'sticker')) {
    if (extname(file).toLowerCase() !== '.svg') continue
    const filename = basename(file)
    const codepoints = codepointsFromStickerFile(filename)
    if (codepoints.length === 0) continue
    const char = charFromCodepoints(codepoints)
    entries.push({
      id: `sticker:${codepoints.join('-').toLowerCase()}`,
      kind: 'sticker',
      name: char || codepoints.join('-'),
      file: rel(file),
      tags: [char, ...codepoints].filter(Boolean),
      meta: { codepoints, char }
    })
  }

  for (const file of await walkKind(root, 'prop')) {
    if (!IMAGE_EXT.has(extname(file).toLowerCase())) continue
    const filename = basename(file)
    const name = filename.replace(/\.[^.]+$/, '').replace(/_3d$/i, '').replace(/[_-]+/g, ' ')
    entries.push({
      id: `prop:${slugify(filename)}`,
      kind: 'prop',
      name,
      file: rel(file),
      tags: [...name.split(' '), '3d'],
      meta: {}
    })
  }

  for (const file of await walkKind(root, 'title')) {
    if (extname(file).toLowerCase() !== '.svg') continue
    const filename = basename(file)
    const name = filename.replace(/\.svg$/i, '').replace(/[_-]+/g, ' ')
    entries.push({
      id: `title:${slugify(filename)}`,
      kind: 'title',
      name,
      file: rel(file),
      tags: name.split(' '),
      meta: await titleMeta(file)
    })
  }

  for (const file of await walkKind(root, 'transition')) {
    const ext = extname(file).toLowerCase()
    const isSvg = ext === '.svg'
    if (!isSvg && !IMAGE_EXT.has(ext)) continue
    const filename = basename(file)
    const group = basename(dirname(file))
    const name = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
    entries.push({
      id: `transition:${slugify(`${group}-${filename}`)}`,
      kind: 'transition',
      name,
      file: rel(file),
      tags: [...name.split(' '), group],
      meta: { maskType: isSvg ? 'svg' : 'image', group }
    })
  }

  return {
    version: CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    scannedFrom: root,
    entries
  }
}

/** How many of each kind the scan found — for the UI and for diagnosing an empty library. */
export function catalogSummary(catalog: AssetCatalog): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of catalog.entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
  return counts
}

/* ------------------------------------------------------------- caching */

let cached: AssetCatalog | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'asset-catalog.json')
}

/**
 * Scanning ~1,800 files takes about a second, which is too long to repeat on
 * every launch. The result is cached to userData and invalidated when the
 * assets root or the catalog format changes.
 */
export async function loadCatalog(force = false): Promise<AssetCatalog> {
  if (cached && !force) return cached
  const root = assetsRoot()

  if (!force) {
    try {
      const raw = JSON.parse(await readFile(cachePath(), 'utf8')) as AssetCatalog
      if (raw.version === CATALOG_VERSION && raw.scannedFrom === root) {
        cached = raw
        return cached
      }
    } catch {
      // No cache, corrupt cache, or a stale format — rescan.
    }
  }

  cached = await scanAssets(root)
  try {
    await mkdir(dirname(cachePath()), { recursive: true })
    await writeFile(cachePath(), JSON.stringify(cached), 'utf8')
  } catch {
    // An unwritable cache is not worth failing over; the scan still worked.
  }
  return cached
}

/** Absolute path for a catalog entry's file. */
export function resolveAssetFile(relativePath: string): string {
  /*
   * An absolute path is already resolved.
   *
   * `join` does NOT treat an absolute second argument as absolute — it
   * concatenates — so a generated PNG at /Users/x/titles/a.png became
   * /assets/root/Users/x/titles/a.png and every attempt to place text, a colour
   * card or a title died with ENOENT. Generated artwork lives in the app's own
   * cache, not under the assets root, so it arrives here absolute.
   */
  if (isAbsolute(relativePath)) return relativePath
  return join(assetsRoot(), relativePath)
}

export async function assetsRootExists(): Promise<boolean> {
  try {
    return (await stat(assetsRoot())).isDirectory()
  } catch {
    return false
  }
}
