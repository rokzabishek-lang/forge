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

/**
 * Stickers come in two shapes, and they have nothing in common but the drawer
 * they live in.
 *
 * An EMOJI is one SVG named by codepoint. A CLIP is a keyed video cut-out —
 * a colour `.mp4` beside a matte `.mp4`, recombined with `alphamerge` at render,
 * which is the same pairing `plan.ts` already uses for masks. H.264 4:2:0
 * cannot carry an alpha channel, so a single file was never an option; see
 * `docs/STICKERS.md`.
 */
export type StickerMeta = EmojiStickerMeta | ClipStickerMeta

export interface EmojiStickerMeta {
  form: 'emoji'
  /** Unicode codepoints the filename encodes, e.g. ["1F525"]. */
  codepoints: string[]
  /** The actual character, for search. */
  char: string
}

export interface ClipStickerMeta {
  form: 'clip'
  /** The matte, relative to the catalog root like `file` is. */
  matte: string
  /**
   * A cut-out still for the Library grid, relative like `file`.
   *
   * The grid draws every asset with an `<img>`, and a clip sticker is an mp4 —
   * so without this the whole drawer is blank tiles: the pack installs, the
   * catalog is right, and the user sees nothing. WebP because these are
   * photographic cut-outs, which is PNG's worst case: measured at 128px, 2.8 KB
   * against 25.6 KB.
   */
  thumb?: string
  /**
   * The pack's category, as the pack states it (`01_Telugu_Memes_and_…`).
   *
   * Kept raw rather than pre-formatted so the chip label and the tooltip are
   * both derived from one string — sheet ⑨ wants a category row, and somebody
   * with four packs installed otherwise has six hundred stickers in one
   * undifferentiated grid.
   */
  category?: string
  width: number
  height: number
  durationMs: number
  /**
   * Authored to repeat, so it fills the host clip rather than playing once.
   *
   * Decided when the pack is built, by comparing the first and last frame, so
   * the app never shows anybody a dialog about playback semantics. Stretching
   * is never offered: a 2s reaction across 30s plays at 1/15 speed, and with a
   * meme the timing is the joke.
   */
  loops: boolean
  /**
   * Muted by default when placed. 92% of the vault is at conversational
   * loudness or louder and for a talking meme the sound IS the joke, so it
   * ships — but six stickers all talking at once is not what anybody wanted.
   */
  hasAudio: boolean
}

export function isClipSticker(meta: unknown): meta is ClipStickerMeta {
  return !!meta && (meta as ClipStickerMeta).form === 'clip'
}

/**
 * A category name short enough to be a chip.
 *
 * Sheet ⑨ draws "Categories: Telugu, Hindi, trending …etc" as a row above the
 * grid, and the panel it lives in is about 280px wide. The packs are named for
 * a filesystem — `01_Telugu_Memes_and_Punchlines` — and printing those in full
 * gives ten chips that wrap to five rows and stop being a row at all.
 *
 * So: drop the sort-order prefix and any trailing year, take the first two
 * words, and never end on a conjunction — `Tech_and_Business_Titans` would
 * otherwise read "Tech and". The full name still goes in the tooltip, and into
 * `tags` so search finds the words this drops.
 */
export function stickerCategoryLabel(raw: string): string {
  const words = raw
    .replace(/^\d+[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+\d{4}(\s+\d{4})?\s*$/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return ''
  const short = words.slice(0, 2)
  if (short.length > 1 && /^(and|&|of|the|with)$/i.test(short[1])) short.pop()
  return short.join(' ')
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

/**
 * 2: stickers gained a `form` discriminator and video clips.
 *
 * `loadCatalog` throws away a cache whose version does not match, which is the
 * point of bumping it — a catalog written before clips existed has emoji
 * entries with no `form`, and nothing downstream should have to guess.
 */
export const CATALOG_VERSION = 2

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
