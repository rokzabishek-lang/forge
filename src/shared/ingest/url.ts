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

  return { kind: 'generic', url: parsed.toString(), videoId: null, key: genericKey(parsed) }
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
  // Long enough to stay recognisable, short enough to stay far from Windows'
  // 260-character path limit once a cache directory is in front of it.
  return slug.slice(0, 48) || 'download'
}
