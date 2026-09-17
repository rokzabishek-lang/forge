/**
 * Reading a pasted link.
 *
 * Runs in the renderer the moment something lands in the URL box, so the field
 * can say what it is before anything is spawned — and in main again before
 * anything IS spawned, because a renderer is not a place to validate.
 *
 * The video id is the important part. It is what names the file on disk: a
 * YouTube title is user data going straight into a filename, and titles
 * routinely contain `|`, `?`, `"` and `:`, every one of which Windows refuses.
 * An id is eleven characters of `[A-Za-z0-9_-]` and is safe on both platforms,
 * safe inside an ffmpeg filtergraph, and stable enough to cache on. The title
 * is kept for the asset's display name, where it can say anything it likes.
 */

export type LinkKind = 'youtube' | 'generic'

/**
 * Link shapes that name a COLLECTION rather than one video.
 *
 * These have to be refused, and `--no-playlist` is not the guard people assume.
 * yt-dlp's `_yes_playlist` returns `not video_id` *before* it reads that flag,
 * so with no video id in the URL the whole collection is extracted whatever was
 * passed. Against our `-o <stem>.%(ext)s` every entry maps to the same
 * filename: the first downloads, the rest report already-downloaded, and the
 * title we read back is the LAST one — so the user gets entry 1's bytes under
 * entry N's name, and no sign anything went wrong.
 *
 * Refusing is the honest answer until there is a UI for "which one".
 */
const COLLECTION_PATHS = /^\/(playlist|feed|results|channel|c|user|@[^/]+|.*\/sets)(\/|$)/i

export interface ParsedLink {
  kind: LinkKind
  /** The canonical URL to hand to yt-dlp. */
  url: string
  /** YouTube's eleven-character id, or null for a generic link. */
  videoId: string | null
  /** A filesystem-safe stem for whatever is written to disk. */
  key: string
}

/** YouTube ids are exactly eleven of these, and have been for the site's life. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be'
])

/** `/shorts/ID`, `/embed/ID`, `/v/ID`, `/live/ID` — all carry the id in the path. */
const PATH_FORMS = /^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/

/**
 * Pull the id out of any of YouTube's link shapes, or null.
 *
 * Deliberately built on `URL` rather than one big regex. The regex version of
 * this is a well-known source of bugs — it matches an id out of the MIDDLE of
 * an unrelated string, so a link to some other site that happens to contain
 * eleven word characters is treated as a video.
 */
export function youtubeId(input: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return null

  // youtu.be/ID — the id is the whole path.
  if (parsed.hostname.toLowerCase().endsWith('youtu.be')) {
    const id = parsed.pathname.slice(1).split('/')[0]
    return VIDEO_ID.test(id) ? id : null
  }

  const fromPath = PATH_FORMS.exec(parsed.pathname)
  if (fromPath) return fromPath[1]

  const v = parsed.searchParams.get('v')
  return v && VIDEO_ID.test(v) ? v : null
}

/**
 * Parse anything the user pastes.
 *
 * A non-YouTube link is not rejected. yt-dlp reads well over a thousand sites,
 * and refusing them would be the app inventing a limit the tool underneath does
 * not have — the box says YouTube because that is what the sketch asked for and
 * what people paste, not because the rest is forbidden. It is reported as
 * `generic` so the caller can be honest that quality options may not apply.
 */
export function parseLink(input: string): ParsedLink | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // An argument, not a URL. yt-dlp reads anything starting with `-` as an
  // option, so this must never reach argv even though `new URL` rejects it too.
  if (trimmed.startsWith('-')) return null

  const id = youtubeId(trimmed)
  if (id) {
    return {
      kind: 'youtube',
      // Canonical: drops playlist ids, timestamps and tracking parameters, so
      // the same video pasted three different ways caches as one thing.
      url: `https://www.youtube.com/watch?v=${id}`,
      videoId: id,
      key: id
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (isCollection(parsed)) return null
  /*
   * A host with no dot in it is not a site.
   *
   * `https://y` parses perfectly well as a URL, so without this a half-typed
   * address was accepted, queued, spawned, and came back "Unsupported URL"
   * a second later — a job, a progress bar and an error to learn what the box
   * could have said immediately. localhost is the one real exception.
   */
  const host = parsed.hostname.toLowerCase()
  if (!host.includes('.') && host !== 'localhost') return null

  return { kind: 'generic', url: parsed.toString(), videoId: null, key: genericKey(parsed) }
}

/** A playlist, channel, feed or set — many videos, not one. */
export function isCollection(url: URL): boolean {
  if (COLLECTION_PATHS.test(url.pathname)) return true
  // `list=` with no `v=` is a YouTube playlist page. With a `v=` it is a video
  // that happens to sit in a playlist, which `youtubeId` already handled.
  return url.searchParams.has('list') && !url.searchParams.has('v')
}

/**
 * A stable, filesystem-safe stem for a link with no id of its own.
 *
 * Not a hash: a folder full of hex tells you nothing when something goes wrong.
 * Host plus a squashed path keeps it readable, and the character class is the
 * intersection of what macOS and Windows both allow without argument.
 */
function genericKey(url: URL): string {
  const host = url.hostname.replace(/^www\./, '')
  const tail = `${url.pathname}${url.search}`
  const slug = `${host}${tail}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  /*
   * Truncating alone is not safe: two different URLs sharing their first 48
   * characters would collide, and a collision here is not a mangled name — it
   * is the second link being served the first link's FILE as a cache hit. Long
   * paths with a shared prefix are exactly how real sites are laid out.
   *
   * So the readable slug is truncated for humans and a short digest of the
   * whole canonical URL is appended for uniqueness. Kept short because Windows
   * caps a path at 260 characters once a cache directory sits in front of it.
   */
  return `${slug.slice(0, 40) || 'download'}-${shortDigest(url.toString())}`
}

/**
 * Eight hex characters from a URL, without importing node:crypto.
 *
 * This file is shared with the renderer, which has no crypto module — and the
 * job here is telling two URLs apart in a filename, not resisting an attacker.
 * FNV-1a over two offset passes gives 64 bits, which is far more than enough
 * for the handful of downloads one person accumulates.
 */
function shortDigest(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0
    b = Math.imul(b ^ text.charCodeAt(text.length - 1 - i), 0x01000193) >>> 0
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 8)
}

/** What is wrong with what has been typed so far, or null when nothing is. */
export type LinkProblem = 'empty' | 'not-a-link' | 'collection'

/**
 * One answer for the panel's inline hint and the store's message.
 *
 * They used to decide separately — the panel on `/^https?:\/\//` and the store
 * on the same test applied to different text — so a half-typed `https://y` was
 * called "a playlist, channel or feed" by one and something else by the other,
 * about the same input, at the same time.
 */
export function linkProblem(input: string): LinkProblem | null {
  const trimmed = input.trim()
  if (!trimmed) return 'empty'
  if (parseLink(trimmed)) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'not-a-link'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'not-a-link'
  // It IS a URL and parseLink still refused it, so the shape is the problem.
  return isCollection(parsed) ? 'collection' : 'not-a-link'
}

/** What to say about it, in one place so the two callers cannot diverge. */
export const LINK_PROBLEM_TEXT: Record<LinkProblem, string> = {
  empty: 'Paste a link to a video first.',
  'not-a-link': 'That does not look like a link yet.',
  collection: 'That is a playlist, channel or feed. Paste a link to one video.'
}
