/**
 * The asset library as something fetched, not shipped — and not as one thing.
 *
 * `docs/ASSETS.md` §"Open decision" weighed three options and chose this one.
 * What that entry did not anticipate is that the SAME machinery wants to carry
 * the sticker library too, and that neither should arrive as a single lump:
 * sheet ⑨ asks for categories (Telugu, Hindi, trending), and once categories
 * exist they are the obvious unit of download. Somebody editing Telugu content
 * should not be made to fetch SpongeBob to get it.
 *
 * So: a list of packs, each independently installable, each with its own size
 * and checksum. Adding pack number seven later costs a release, four lines of
 * manifest and no code at all.
 *
 * The rule that shapes everything here: **the app works with none of them.**
 * `scanAssets` returns an empty catalog for a missing root, eight built-in
 * transitions exist with no masks at all, and captions fall back to system
 * fonts. A missing pack costs choices, never function — so nothing here may
 * block startup, and every failure has to be recoverable by pressing the button
 * again.
 *
 * Pure, so the version logic, the path safety and the size arithmetic are all
 * tested with no network and no electron.
 */

/** The manifest format, not the packs. Bumped if the SHAPE below changes. */
export const MANIFEST_VERSION = 1

export interface Pack {
  /** Stable, filename-safe, and the directory it installs into. */
  id: string
  name: string
  /** What the user is being asked to spend bandwidth on, in their words. */
  summary: string
  /** Groups packs in the UI: the asset library, or a sticker category. */
  group: 'library' | 'stickers'
  /** Bumped when the CONTENTS change, which is what makes a pack stale. */
  version: number
  url: string
  /** sha256 of the .tar.gz, hex. Verified before a single file is written. */
  sha256: string
  /** Compressed size, for the button and a disk-space check. */
  bytes: number
}

export interface PackManifest {
  manifestVersion: number
  packs: Pack[]
}

/**
 * What this build ships knowing about.
 *
 * Checked in rather than fetched, deliberately: a manifest fetched at startup
 * is a second network dependency and a second thing that can be wrong, and the
 * Library must open instantly whether or not a server is up. `mergeManifest`
 * exists so a newer list can be layered on top when one is available — current
 * packs without making a working panel depend on a request.
 *
 * Entries live here with an empty `sha256` until their release is cut;
 * `isPublished` hides those, because a button that 404s makes a working app
 * look broken, which is the failure this project keeps circling back to.
 */
export const BUILT_IN_MANIFEST: PackManifest = {
  manifestVersion: MANIFEST_VERSION,
  packs: [
    {
      id: 'library',
      name: 'Asset library',
      summary: '88 fonts, 412 transitions, 50 title templates, SFX and props',
      group: 'library',
      version: 1,
      url: 'https://github.com/rokzabishek-lang/forge/releases/download/assets-v1/library.tar.gz',
      sha256: '',
      bytes: 85_000_000
    }
  ]
}

/** A pack with a real checksum and an https URL is one we can actually fetch. */
export function isPublished(pack: Pack): boolean {
  return /^[0-9a-f]{64}$/.test(pack.sha256) && pack.url.startsWith('https://')
}

/**
 * A pack id has to be safe as a directory name on both platforms.
 *
 * It names a folder under the install root, so the Windows filename rules apply
 * — and this is the one field a future manifest could get wrong in a way that
 * only breaks on the platform nobody is looking at.
 */
export function isValidPackId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id)
}

/**
 * Layer a fetched manifest over the built-in one.
 *
 * Unknown packs are added, known ones are replaced, and anything malformed is
 * dropped rather than trusted — a remote list is untrusted input even when we
 * publish it, and a bad entry must not be able to remove a good built-in one.
 */
export function mergeManifest(
  builtIn: PackManifest,
  fetched: unknown
): { packs: Pack[]; usedRemote: boolean } {
  const remote = fetched as PackManifest | null
  if (
    !remote ||
    typeof remote !== 'object' ||
    remote.manifestVersion !== MANIFEST_VERSION ||
    !Array.isArray(remote.packs)
  ) {
    return { packs: builtIn.packs, usedRemote: false }
  }

  const byId = new Map(builtIn.packs.map((p) => [p.id, p]))
  let used = false
  for (const raw of remote.packs) {
    if (!isPack(raw)) continue
    byId.set(raw.id, raw)
    used = true
  }
  return { packs: [...byId.values()], usedRemote: used }
}

function isPack(value: unknown): value is Pack {
  const p = value as Pack
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    isValidPackId(p.id) &&
    typeof p.name === 'string' &&
    typeof p.summary === 'string' &&
    (p.group === 'library' || p.group === 'stickers') &&
    Number.isInteger(p.version) &&
    p.version > 0 &&
    typeof p.url === 'string' &&
    p.url.startsWith('https://') &&
    typeof p.sha256 === 'string' &&
    Number.isFinite(p.bytes) &&
    p.bytes > 0
  )
}

export type PackState =
  | { kind: 'unpublished' }
  | { kind: 'available' }
  | { kind: 'stale'; installed: number }
  | { kind: 'installed'; version: number }

/**
 * What to say about one pack, given what is on disk.
 *
 * `installed` is the version recorded beside the files, or null when there is
 * none — which is also what a hand-placed library looks like, and that counts
 * as installed. Somebody who pointed `FORGE_ASSETS_DIR` at their own folder has
 * not made a mistake and should not be told to download anything.
 */
export function packState(pack: Pack, installed: number | null): PackState {
  if (!isPublished(pack)) return { kind: 'unpublished' }
  if (installed === null) return { kind: 'available' }
  if (installed < pack.version) return { kind: 'stale', installed }
  return { kind: 'installed', version: installed }
}

/**
 * Is this archive member safe to write?
 *
 * An archive is untrusted input even when we made it: a member named
 * `../../etc/passwd` escapes the directory it is unpacked into, which is the
 * oldest bug in archive handling and still worth writing down. Absolute paths,
 * drive letters, parent traversal and backslashes are REFUSED rather than
 * normalised — a legitimate member of our packs has none of them, so anything
 * that does is either corrupt or hostile, and both deserve the same answer.
 */
export function safeMemberPath(name: string): string | null {
  if (!name) return null
  if (name.startsWith('/') || name.startsWith('\\')) return null
  if (/^[A-Za-z]:/.test(name) || name.startsWith('\\\\')) return null
  // Not a separator in tar; a member containing one has a backslash in its
  // name, which Windows forbids anyway.
  if (name.includes('\\')) return null
  const parts = name.split('/')
  /*
   * These two overlap, deliberately.
   *
   * `..` ends in a dot, so the Windows rule below catches it as well — a
   * mutation check proved the traversal test alone was never the thing doing
   * the work. Both stay: the Windows rule is about a platform and could one day
   * be relaxed for a Linux build, and the traversal rule is about safety and
   * never can be. Each is asserted on its own in the tests for that reason.
   */
  if (parts.some((part) => part === '..' || part === '')) return null
  // The Windows rules that have already bitten this project twice.
  if (parts.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) return null
  return name
}

/** 0..1 across a download, or null while the total is unknown. */
export function packProgress(received: number, total: number | null): number | null {
  if (total === null || total <= 0) return null
  return Math.max(0, Math.min(1, received / total))
}

/** `81 MB` — for a button that is asking someone to spend their bandwidth. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
