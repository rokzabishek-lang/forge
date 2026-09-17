/**
 * The asset catalog.
 *
 * Assets are indexed by a build-time scan into a manifest, so the app never walks
 * the filesystem at startup. Entries store paths RELATIVE to an assets root, which
 * is resolved at runtime — that keeps "what assets exist" independent of "where
 * they are installed", and lets the same catalog serve dev and a packaged app.
 */

export type AssetKind = 'font' | 'sfx' | 'sticker' | 'prop' | 'title' | 'transition'

/** Whether a font ships with the app or is expected to already exist on the OS. */
export type FontSource = 'bundled' | 'system'

export interface FontMeta {
  family: string
  source: FontSource
  /** Set when the filename itself declares a usage restriction. */
  restricted?: boolean
}

export interface SfxMeta {
  durationMs: number | null
}

export interface StickerMeta {
  /** Unicode codepoints the filename encodes, e.g. ["1F525"]. */
  codepoints: string[]
  /** The actual character, for search. */
  char: string
}

export interface TitleMeta {
  width: number
  height: number
  /** How many <text> nodes can be substituted. */
  textSlots: number
}

export interface TransitionMeta {
  /** Luma masks drive a wipe; 'builtin' entries need no file at all. */
  maskType: 'svg' | 'image'
  group: string
}

export interface CatalogEntry {
  id: string
  kind: AssetKind
  name: string
  /** Path relative to the catalog root. */
  file: string
  tags: string[]
  meta: FontMeta | SfxMeta | StickerMeta | TitleMeta | TransitionMeta | Record<string, never>
}

export interface AssetCatalog {
  version: number
  generatedAt: string
  /** Absolute path the scan ran against, recorded for provenance only. */
  scannedFrom: string
  entries: CatalogEntry[]
}

export const CATALOG_VERSION = 1

/**
 * Fonts that ship with macOS and/or Windows. These are referenced by family name
 * rather than bundled: the file is already on the machine, so shipping it adds
 * megabytes and redistributes someone else's font for no benefit.
 */
export const SYSTEM_FONT_FAMILIES = new Set([
  'Arial',
  'Arial Black',
  'Comic Sans MS',
  'Copperplate',
  'Courier New',
  'Futura',
  'Georgia',
  'Impact',
  'Tahoma',
  'Trebuchet MS',
  'Verdana'
])

/** Filenames that declare their own restriction. */
const RESTRICTED_MARKERS = [/personal[_\s-]?use/i, /\bdemo\b/i, /\btrial\b/i]

export function isRestrictedFontFile(filename: string): boolean {
  return RESTRICTED_MARKERS.some((re) => re.test(filename))
}

/**
 * Derive a display family from a font filename.
 * "BebasNeue-Regular.ttf" -> "Bebas Neue", "Arial Bold.ttf" -> "Arial"
 */
export function fontFamilyFromFilename(filename: string): string {
  const stem = filename.replace(/\.(ttf|otf|ttc|woff2?)$/i, '')
  const withoutStyle = stem
    .replace(/[-_](Regular|Bold|Black|Italic|ExtraBold|SemiBold|Light|Medium|Thin|BoldItalic)$/i, '')
    .replace(/_?PERSONAL_USE_ONLY/i, '')
    .replace(/\s+(Bold|Black|Regular|Italic|Bold Italic)$/i, '')
    .trim()

  // CamelCase to spaced words, leaving already-spaced names alone.
  return withoutStyle.includes(' ')
    ? withoutStyle
    : withoutStyle.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim()
}

export function fontSourceFor(family: string): FontSource {
  return SYSTEM_FONT_FAMILIES.has(family) ? 'system' : 'bundled'
}

/** "1F1E6-1F1E8.svg" -> ["1F1E6", "1F1E8"] */
export function codepointsFromStickerFile(filename: string): string[] {
  const stem = filename.replace(/\.svg$/i, '')
  return stem.split(/[-_]/).filter((part) => /^[0-9A-Fa-f]{2,6}$/.test(part))
}

export function charFromCodepoints(codepoints: string[]): string {
  try {
    return String.fromCodePoint(...codepoints.map((c) => Number.parseInt(c, 16)))
  } catch {
    return ''
  }
}

/* -------------------------------------------------------------- querying */

export function entriesOfKind(catalog: AssetCatalog, kind: AssetKind): CatalogEntry[] {
  return catalog.entries.filter((e) => e.kind === kind)
}

/** Case-insensitive match across name and tags. */
export function searchCatalog(
  catalog: AssetCatalog,
  query: string,
  kind?: AssetKind
): CatalogEntry[] {
  const needle = query.trim().toLowerCase()
  const pool = kind ? entriesOfKind(catalog, kind) : catalog.entries
  if (needle === '') return pool
  return pool.filter(
    (e) =>
      e.name.toLowerCase().includes(needle) ||
      e.tags.some((t) => t.toLowerCase().includes(needle))
  )
}

export function findEntry(catalog: AssetCatalog, id: string): CatalogEntry | null {
  return catalog.entries.find((e) => e.id === id) ?? null
}

/**
 * One entry per font family — the catalog holds a file per weight.
 *
 * Deliberately a plain function rather than a store selector: a selector that
 * builds a fresh array every render makes zustand see a change every time, and
 * the component re-renders until React tears the tree down.
 */
export function fontFamilies(catalog: AssetCatalog | null): CatalogEntry[] {
  if (!catalog) return []
  const seen = new Set<string>()
  return entriesOfKind(catalog, 'font').filter((entry) => {
    const family = (entry.meta as FontMeta).family
    if (seen.has(family)) return false
    seen.add(family)
    return true
  })
}

export function searchEntries(
  catalog: AssetCatalog | null,
  query: string,
  kind?: AssetKind
): CatalogEntry[] {
  return catalog ? searchCatalog(catalog, query, kind) : []
}

/**
 * ffmpeg's xfade transitions need no asset files. They are the baseline set the
 * app always has, with the luma-mask library layered on top of them.
 */
export const BUILTIN_TRANSITIONS = [
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'radial', 'smoothleft', 'smoothright',
  'pixelize', 'hlslice', 'vuslice', 'zoomin'
] as const
