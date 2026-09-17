import { describe, it, expect } from 'vitest'
import { parseRange, MEDIA_TYPES } from '../src/main/mediaProtocol'
import { mediaUrl } from '../src/shared/mediaUrl'

/*
 * The protocol served every request as a whole-file 200 with no Accept-Ranges.
 *
 * Video tolerated it — it buffers forward from the start — but Chromium's audio
 * pipeline asks for byte ranges, got a fresh full-file response each time, and
 * restarted its decode over and over. That came out of the speakers as a
 * continuous crackle while the exported file, which ffmpeg reads straight off
 * disk, was perfect.
 */
describe('parseRange', () => {
  const SIZE = 1000

  it('reads an explicit range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 })
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 })
  })

  it('reads an open-ended range as "to the end"', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 })
  })

  it('reads a suffix range as the LAST n bytes', () => {
    // Not "from byte 500" — getting this backwards serves the wrong audio.
    expect(parseRange('bytes=-200', SIZE)).toEqual({ start: 800, end: 999 })
  })

  it('clamps an end past the file rather than reading off the end', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 })
  })

  it('refuses nonsense instead of serving garbage', () => {
    expect(parseRange(null, SIZE)).toBeNull()
    expect(parseRange('', SIZE)).toBeNull()
    expect(parseRange('items=0-10', SIZE)).toBeNull()
    expect(parseRange('bytes=abc-def', SIZE)).toBeNull()
    // start after end, and start past the file
    expect(parseRange('bytes=800-200', SIZE)).toBeNull()
    expect(parseRange('bytes=1000-1200', SIZE)).toBeNull()
    expect(parseRange('bytes=-0', SIZE)).toBeNull()
  })

  it('tolerates whitespace', () => {
    expect(parseRange('  bytes=0-9 ', SIZE)).toEqual({ start: 0, end: 9 })
  })
})

describe('MEDIA_TYPES', () => {
  it('names a type for every format the app imports', () => {
    // A missing or wrong Content-Type makes the media stack sniff, and a
    // sniffed audio stream is where stuttering starts.
    for (const ext of ['.mp3', '.m4a', '.wav', '.aac', '.flac', '.mp4', '.mov', '.png', '.jpg']) {
      expect(MEDIA_TYPES[ext]).toBeTruthy()
    }
  })

  it('serves fonts with a font type, since they are CORS-fetched', () => {
    expect(MEDIA_TYPES['.ttf']).toMatch(/^font\//)
    expect(MEDIA_TYPES['.woff2']).toMatch(/^font\//)
  })
})

/*
 * Text, colour cards and titles are rewritten in place at one path per clip, so
 * the URL never changed and Chromium kept serving its cached first copy. You
 * typed, the file on disk updated, and the picture still said YOUR TEXT.
 */
describe('mediaUrl', () => {
  const FILE = '/Users/x/Library/titles/text-abc.png'

  it('gives a different URL for each version of generated artwork', () => {
    expect(mediaUrl(FILE, 1)).not.toEqual(mediaUrl(FILE, 2))
  })

  it('leaves real media uncached-busted, so it stays cached', () => {
    expect(mediaUrl(FILE)).not.toContain('&v=')
  })

  it('passes a URL straight through', () => {
    // A blob: or data: source was made in the renderer and has no file behind
    // it for the protocol to serve. Wrapping it would only hide that.
    for (const url of ['blob:http://localhost/abc', 'data:image/png;base64,AAA', 'https://x/y.png']) {
      expect(mediaUrl(url)).toBe(url)
      expect(mediaUrl(url, 3)).toBe(url)
    }
  })

  it('keeps the path readable by the handler whether or not a version is set', () => {
    for (const url of [mediaUrl(FILE), mediaUrl(FILE, 7)]) {
      expect(new URL(url).searchParams.get('p')).toEqual(FILE)
    }
  })
})
