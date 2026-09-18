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
  /** Groups packs in the UI: the asset library, sounds, or a sticker category. */
  group: 'library' | 'sounds' | 'stickers'
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
      summary: '88 fonts, 412 transitions, 1,239 emoji, 50 titles, 23 sounds',
      group: 'library',
      version: 1,
      /*
       * A SEPARATE, PUBLIC repo, not the source one.
       *
       * The app fetches this with a plain `fetch` and no credentials, and it
       * must stay that way — shipping a token to reach your own assets is a
       * token in every user's app bundle. GitHub answers an unauthenticated
       * request for a private repo's release asset with a flat 404, so a pack
       * published from a private repo can never be installed by anyone. Found
       * by fetching it before publishing the checksum, which is the whole
       * reason that order exists.
       */
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/assets-v1/library.tar.gz',
      /*
       * Both printed by `scripts/build-pack.mjs`, and both verified against the
       * PUBLISHED file with no credentials before being written here — see
       * docs/ASSETS.md for why that order is a step and not a formality.
       * `bytes` is the compressed size, because it is what the button asks
       * somebody to spend.
       */
      sha256: 'd6daf449b1e4f014bc7f0a5f89d3c137bfef0b0ec5da3195f23295e2ba3cf985',
      bytes: 59_684_563
    },
    {
      id: 'sfx-meme-sounds',
      name: 'Meme sound effects',
      summary: '105 sound effects — quacks, sirens, horns, error chimes',
      group: 'sounds',
      version: 1,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/sfx-meme-sounds.tar.gz',
      sha256: '76423d63302de9ea7a4d06a8d63140450ca997e6e7b00ffe509679596b8007e4',
      bytes: 6_642_078
    },
    {
      id: 'stickers-epic-fails-accidents',
      name: 'Epic fails & accidents',
      summary: '63 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-epic-fails-accidents.tar.gz',
      sha256: '942e1724bbc19ecf4c7f378d62ff2670a750549683d3847b92f46adb901870a7',
      bytes: 22_738_791
    },
    {
      id: 'stickers-global-editing-memes',
      name: 'Global editing memes',
      summary: '89 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-global-editing-memes.tar.gz',
      sha256: 'd44e454ef1359a28cf032ceee70136210af2a86d3d574731c79aee454a4abfb0',
      bytes: 26_997_473
    },
    {
      id: 'stickers-global-memes-and-streamers-2025-2026',
      name: 'Global memes & streamers',
      summary: '57 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-global-memes-and-streamers-2025-2026.tar.gz',
      sha256: '59e9dece2d8af1e5d08d1c4e24f72cd6636e52eb643142e2d51bb1192e46da5b',
      bytes: 23_729_039
    },
    {
      id: 'stickers-hindi-meme-punchlines',
      name: 'Hindi meme punchlines',
      summary: '90 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-hindi-meme-punchlines.tar.gz',
      sha256: '41612d8ddfdefcdb89c7a555af5654f803acac6d28e341b4fe14e6d19812af60',
      bytes: 20_253_784
    },
    {
      id: 'stickers-indian-media-and-tv-debates',
      name: 'Indian TV debates',
      summary: '55 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-indian-media-and-tv-debates.tar.gz',
      sha256: 'e29ea240d4e8f721a5956ac22fe15b554c3911d3532641a69cbf47b105ffe5c8',
      bytes: 19_729_171
    },
    {
      id: 'stickers-indian-standup-and-reality-tv',
      name: 'Indian standup & reality TV',
      summary: '54 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-indian-standup-and-reality-tv.tar.gz',
      sha256: '2e2c8d40eea52d90016f18ae73e83aa85d3759119f6f8a73967c6adc39264828',
      bytes: 23_643_025
    },
    {
      id: 'stickers-middle-eastern-and-global-culture',
      name: 'Middle Eastern culture',
      summary: '52 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-middle-eastern-and-global-culture.tar.gz',
      sha256: 'dcd694c760e445c5e9bf51d02b92a39597d76def5aacc361e7515688e07bc067',
      bytes: 31_228_993
    },
    {
      id: 'stickers-spongebob-cutaways',
      name: 'SpongeBob cutaways',
      summary: '7 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-spongebob-cutaways.tar.gz',
      sha256: '4cccd0923960fce996e6395983b2c6dc2755f1c7494abbaff25c8bc84b3e9c32',
      bytes: 438_123
    },
    {
      id: 'stickers-tech-and-business-titans',
      name: 'Tech & business titans',
      summary: '51 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-tech-and-business-titans.tar.gz',
      sha256: '27e821242a662d8ee5908136cabce04affcad8a30e0ba9aba3d14a8c2ed1dc89',
      bytes: 16_983_431
    },
    {
      id: 'stickers-telugu-memes-and-punchlines',
      name: 'Telugu memes & punchlines',
      summary: '118 meme stickers, with transparency and sound',
      group: 'stickers',
      version: 2,
      url: 'https://github.com/rokzabishek-lang/forge-assets/releases/download/stickers-v1/stickers-telugu-memes-and-punchlines.tar.gz',
      sha256: 'bc7d384f53f3cae0fd8cc724e09e0a6aa94c72473b614b8549d28e1c450ecf10',
      bytes: 39_841_798
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
    (p.group === 'library' || p.group === 'sounds' || p.group === 'stickers') &&
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

/** A pack plus what is on disk — what both sides of the IPC actually pass. */
export interface PackListing extends Pack {
  state: PackState
}

/** A download in flight, as the renderer knows it. */
export interface PackProgress {
  /** 0..1, or null while the total is unknown. */
  progress: number | null
  message: string
}

export interface PackButton {
  /** What pressing it does. `null` means it cannot be pressed. */
  action: 'install' | 'cancel' | 'remove' | null
  label: string
  /** A bar to draw, or null for no bar rather than a bar at zero. */
  progress: number | null
  /** The line under the button, in the user's words. */
  detail: string
  busy: boolean
}

/**
 * One pack, as one button.
 *
 * Pure so the thing a user will actually judge the feature by — whether the
 * button says the true thing at each moment — is decided somewhere it can be
 * tested. The ORDER of these branches is the whole content of the function:
 *
 * - A download in flight wins over everything. It is the only state the user
 *   can see changing, and offering "Download" beside a moving bar invites a
 *   second one.
 * - A failure wins over what is on disk, including `installed`. A failed
 *   UPDATE leaves the old version installed and working, and a button reading
 *   "Remove" there answers a question nobody asked — the user wants another go.
 * - Unpublished is last, and unreachable from the other two: nothing can be
 *   fetched or fail before its release is cut.
 */
export function packButton(
  pack: Pack,
  state: PackState,
  inFlight: PackProgress | null,
  error: string | null
): PackButton {
  if (inFlight) {
    return {
      action: 'cancel',
      label: 'Cancel',
      progress: inFlight.progress,
      detail: inFlight.message,
      busy: true
    }
  }

  if (error && state.kind !== 'unpublished') {
    return { action: 'install', label: 'Try again', progress: null, detail: error, busy: false }
  }

  switch (state.kind) {
    case 'unpublished':
      return {
        action: null,
        label: 'Not yet released',
        progress: null,
        detail: pack.summary,
        busy: false
      }
    case 'available':
      return {
        action: 'install',
        label: `Get · ${formatBytes(pack.bytes)}`,
        progress: null,
        detail: pack.summary,
        busy: false
      }
    case 'stale':
      return {
        action: 'install',
        label: `Update · ${formatBytes(pack.bytes)}`,
        progress: null,
        detail: `Version ${state.installed} is installed, ${pack.version} is available`,
        busy: false
      }
    case 'installed':
      return { action: 'remove', label: 'Remove', progress: null, detail: 'Installed', busy: false }
  }
}

/**
 * Packs in the order they should be offered.
 *
 * The asset library first — it is the one that changes what the rest of the app
 * can do, where a sticker category only adds stickers. Sounds next, because one
 * pack of sound effects is useful to everybody and a sticker category is useful
 * to the people who edit in that language. Then categories by name, so a list
 * that grows to a dozen stays somewhere the eye can find a row again.
 */
const GROUP_ORDER: Record<Pack['group'], number> = { library: 0, sounds: 1, stickers: 2 }

export function orderPacks(packs: PackListing[]): PackListing[] {
  return [...packs].sort((a, b) => {
    if (a.group !== b.group) return GROUP_ORDER[a.group] - GROUP_ORDER[b.group]
    return a.name.localeCompare(b.name)
  })
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
