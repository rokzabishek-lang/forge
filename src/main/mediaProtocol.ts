import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

/**
 * Serving local media to the renderer over the privileged `forge-media` scheme.
 *
 * Separate from index.ts so the range parsing can be tested without booting
 * Electron — importing index.ts runs protocol registration at module load.
 */

/** What the media stack needs to decode a file without sniffing it. */
export const MEDIA_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** `bytes=0-1023`, `bytes=500-`, `bytes=-500`. Null when absent or unusable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match

  let start: number
  let end: number
  if (rawStart === '') {
    // A suffix range: the LAST n bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

export function registerMediaProtocol(): void {
  protocol.handle('forge-media', async (request) => {
    // The path travels as a query parameter so Windows drive letters and
    // backslashes never have to survive URL path encoding.
    const target = new URL(request.url).searchParams.get('p')
    if (!target) return new Response('Missing path', { status: 400 })

    // Fonts are ALWAYS fetched in CORS mode, unlike images and video. Without an
    // allow-origin header every FontFace.load() fails with an opaque "network
    // error" even though the file is served fine — which is exactly what it did.
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Type': MEDIA_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // Announce range support, or the media stack will not ask for one.
      'Accept-Ranges': 'bytes'
    })

    let size: number
    try {
      size = (await stat(target)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    /*
     * Serve byte ranges.
     *
     * This used to hand every request the whole file with a 200 and no
     * Accept-Ranges. Video survived that, because it just buffers forward from
     * the start; audio did not. Chromium's audio pipeline asks for ranges, got a
     * fresh full-file response each time, and restarted its decode over and
     * over — which came out of the speakers as a continuous crackle while the
     * exported file, which ffmpeg reads straight off disk, was perfect.
     */
    const range = parseRange(request.headers.get('Range'), size)
    if (!range) {
      headers.set('Content-Length', String(size))
      return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, {
        status: 200,
        headers
      })
    }

    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    return new Response(
      Readable.toWeb(createReadStream(target, { start: range.start, end: range.end })) as ReadableStream,
      { status: 206, headers }
    )
  })
}

