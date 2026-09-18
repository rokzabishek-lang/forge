import { describe, it, expect } from 'vitest'
import {
  buildYtDlpArgs,
  downloadKind,
  FILE_MARK,
  humanError,
  needsStems,
  outputStem,
  readMarkedLine,
  TITLE_MARK,
  type IngestRequest
} from '@shared/ingest/args'
import { parseLink } from '@shared/ingest/url'
import { PROGRESS_TEMPLATE } from '@shared/ingest/progress'

const URL = 'https://youtu.be/dQw4w9WgXcQ?si=tracking&t=42'
const CONTEXT = { ffmpegPath: '/app/bin/ffmpeg', destDir: '/data/downloads', stem: 'dQw4w9WgXcQ.video-1080p' }

/** The argv, and a helper to read the value after a flag. */
function build(over: Partial<IngestRequest> = {}) {
  const request: IngestRequest = { url: URL, kind: 'video', quality: '1080p', ...over }
  const built = buildYtDlpArgs(request, CONTEXT)
  const after = (flag: string): string | undefined => {
    const at = built.args.indexOf(flag)
    return at === -1 ? undefined : built.args[at + 1]
  }
  const every = (flag: string): string[] =>
    built.args.flatMap((a, i) => (a === flag ? [built.args[i + 1]] : []))
  return { ...built, after, every }
}

describe('the yt-dlp command line', () => {
  it('hands over the canonical URL, not what was pasted', () => {
    // Tracking parameters and the timestamp are gone; the playlist would be.
    // Position is not asserted — yt-dlp takes flags either side of the URL.
    expect(build().args).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(build().args).toContain('--no-playlist')
  })

  it('ignores the user\u2019s own yt-dlp config', () => {
    /*
     * Every flag here is chosen for a reason — AV1 is excluded because the
     * Windows ffmpeg cannot decode it, the title is kept out of the filename
     * because Windows forbids its characters. A stranger's config file can
     * override any of them, so it is not read at all.
     */
    expect(build().args).toContain('--ignore-config')
  })

  it('asks for UTF-8, because Windows pipes the ANSI code page otherwise', () => {
    /*
     * Not cosmetic. We decode stdout as UTF-8, so without this a non-ASCII
     * userData path came back mangled, failed to stat, and the finished
     * download was deleted as "missing".
     */
    expect(build().after('--encoding')).toBe('utf-8')
  })

  it('takes one item, whatever a strange site calls its collection', () => {
    // --no-playlist is not enough on its own: yt-dlp ignores it when the URL
    // carries no video id. parseLink refuses the shapes it recognises; this is
    // the belt for the thousand sites it cannot.
    expect(build().after('--playlist-items')).toBe('1')
  })

  it('uses OUR ffmpeg, never one found on PATH', () => {
    // One media pipeline in the product. yt-dlp merges with this binary, so
    // every feature-floor argument in EFFECTS.md section 25 applies to it.
    expect(build().after('--ffmpeg-location')).toBe('/app/bin/ffmpeg')
  })

  it('keeps --progress, because --print implies --quiet and would silence it', () => {
    /*
     * The trap in this file. `--print` turns on quiet mode, and quiet mode
     * drops the progress lines the bar is drawn from. `--progress` overrides
     * that. Remove it and every download sits at 0% until it is done.
     */
    const { args } = build()
    expect(args).toContain('--print')
    expect(args).toContain('--progress')
    expect(args).toContain('--newline')
  })

  it('keeps --no-simulate, because --print can imply --simulate', () => {
    // A download that quietly simulates is the worst kind of success.
    expect(build().args).toContain('--no-simulate')
  })

  it('asks for exactly our progress line', () => {
    expect(build().after('--progress-template')).toBe(PROGRESS_TEMPLATE)
    expect(build().after('--progress-delta')).toBe('0.2')
  })

  it('asks for the title and the FINAL path, each marked', () => {
    const prints = build().every('--print')
    expect(prints).toContain(`${TITLE_MARK}%(title)s`)
    // after_move: the path once every postprocessor has run. Anything earlier
    // names a file that is about to be renamed or merged away.
    expect(prints).toContain(`after_move:${FILE_MARK}%(filepath)s`)
  })

  it('keeps the directory out of the filename template', () => {
    // A `%` in the directory would otherwise be read as a template field.
    const b = build()
    expect(b.after('-P')).toBe('/data/downloads')
    expect(b.after('-o')).toBe('dQw4w9WgXcQ.video-1080p.%(ext)s')
    expect(b.after('-o')).not.toContain('/')
  })

  it('never puts the title in the filename', () => {
    // The whole point of the stem. Titles contain | ? " and :, and Windows
    // refuses every one of them.
    expect(build().after('-o')).not.toContain('title')
  })

  it('passes the format selector with AV1 excluded and merges to mp4', () => {
    const b = build()
    expect(b.after('-f')).toContain('vcodec!*=av01')
    expect(b.after('--merge-output-format')).toBe('mp4')
  })

  it('passes the size preference as a sort, so vertical video works', () => {
    /*
     * `-f` is what is PERMITTED, `-S` is which of those is BEST. Size has to
     * ride in the sort: as a filter it read `height<=N`, which is false for
     * every vertical video and refused every Short and every reel.
     */
    const b = build()
    expect(b.after('-S')).toContain('res:')
    expect(b.after('-f')).not.toContain('height')
  })

  it('sends no sort for an audio-only download, which has no resolution', () => {
    expect(build({ kind: 'audio' }).args).not.toContain('-S')
  })

  it('extracts audio as m4a by default, copying the stream out', () => {
    const b = build({ kind: 'audio' })
    expect(b.args).toContain('-x')
    expect(b.after('--audio-format')).toBe('m4a')
    expect(b.args).not.toContain('--merge-output-format')
  })

  it('re-encodes to mp3 at the best VBR setting when asked', () => {
    const b = build({ kind: 'audio', audioFormat: 'mp3' })
    expect(b.after('--audio-format')).toBe('mp3')
    expect(b.after('--audio-quality')).toBe('0')
  })

  it('adds the padded section on the fast range path', () => {
    const b = build({ range: { startMs: 60_000, endMs: 90_000 } })
    expect(b.after('--download-sections')).toBe('*50.000-100.000')
    expect(b.args).not.toContain('--force-keyframes-at-cuts')
    expect(b.approximateRange).toBe(true)
    expect(b.requestedRange).toEqual({ startMs: 60_000, endMs: 90_000 })
  })

  it('adds the exact section and the re-encode flag when asked', () => {
    const b = build({ range: { startMs: 60_000, endMs: 90_000 }, exact: true })
    expect(b.after('--download-sections')).toBe('*60.000-90.000')
    expect(b.args).toContain('--force-keyframes-at-cuts')
    expect(b.approximateRange).toBe(false)
  })

  it('retries, because a flaky connection is the common case', () => {
    expect(build().after('--retries')).toBe('5')
    expect(build().after('--socket-timeout')).toBe('30')
  })

  it('refuses something that is not a link', () => {
    expect(() => buildYtDlpArgs({ url: 'not a url', kind: 'video', quality: '720p' }, CONTEXT)).toThrow(
      /not a link/
    )
  })
})

describe('the stem — what makes two asks the same file', () => {
  const link = parseLink(URL)!

  it('differs by kind, quality and format', () => {
    expect(outputStem(link, { url: URL, kind: 'video', quality: '1080p' })).toBe('dQw4w9WgXcQ.video-1080p')
    expect(outputStem(link, { url: URL, kind: 'video', quality: '480p' })).toBe('dQw4w9WgXcQ.video-480p')
    expect(outputStem(link, { url: URL, kind: 'audio', quality: '1080p' })).toBe('dQw4w9WgXcQ.audio-m4a')
    expect(outputStem(link, { url: URL, kind: 'audio', quality: '1080p', audioFormat: 'mp3' })).toBe(
      'dQw4w9WgXcQ.audio-mp3'
    )
  })

  it('differs by range, and normalises a backwards one', () => {
    const a = outputStem(link, { url: URL, kind: 'video', quality: '1080p', range: { startMs: 60_000, endMs: 90_000 } })
    const b = outputStem(link, { url: URL, kind: 'video', quality: '1080p', range: { startMs: 90_000, endMs: 60_000 } })
    // `.fast` because neither asked for an exact cut — see the next test.
    expect(a).toBe('dQw4w9WgXcQ.video-1080p.r60000-90000.fast')
    expect(b).toBe(a)
  })

  it('tells an exact cut from a fast one, which are different files', () => {
    /*
     * An exact cut re-encodes at the marks; a fast cut copies streams and pads
     * outward by ten seconds. Sharing a name meant ticking "exact" after a fast
     * download returned the fast file from cache, instantly and wrongly.
     */
    const range = { startMs: 60_000, endMs: 90_000 }
    const exact = outputStem(link, { url: URL, kind: 'video', quality: '1080p', range, exact: true })
    const fast = outputStem(link, { url: URL, kind: 'video', quality: '1080p', range, exact: false })
    expect(exact).not.toBe(fast)
    expect(exact).toBe('dQw4w9WgXcQ.video-1080p.r60000-90000')
    expect(fast).toBe('dQw4w9WgXcQ.video-1080p.r60000-90000.fast')
  })

  it('is legal on Windows and safe in a filtergraph', () => {
    for (const stem of [
      outputStem(link, { url: URL, kind: 'video', quality: '2160p', range: { startMs: 1500.7, endMs: 9999.2 } }),
      outputStem(parseLink('https://vimeo.com/123?x=a|b')!, { url: '', kind: 'audio', quality: '720p' })
    ]) {
      expect(stem, stem).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })
})

describe('reading yt-dlp back', () => {
  it('reads the two marked lines and nothing else', () => {
    expect(readMarkedLine(`${FILE_MARK}/data/downloads/x.mp4`)).toEqual({ kind: 'file', value: '/data/downloads/x.mp4' })
    expect(readMarkedLine(`  ${TITLE_MARK}Some | Title: "quoted"?  `)).toEqual({
      kind: 'title',
      value: 'Some | Title: "quoted"?'
    })
    expect(readMarkedLine('@forge@downloading|1|2|NA|NA|NA')).toBeNull()
    expect(readMarkedLine('[download] Destination: x.f137.mp4')).toBeNull()
  })

  it('keeps a Windows path intact', () => {
    expect(readMarkedLine(`${FILE_MARK}C:\\Users\\me\\AppData\\forge\\downloads\\x.mp4`)?.value).toBe(
      'C:\\Users\\me\\AppData\\forge\\downloads\\x.mp4'
    )
  })

  it('turns the last ERROR line into the reason a person can act on', () => {
    expect(
      humanError(['[youtube] Extracting URL', 'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable'], 1)
    ).toBe('Video unavailable')
    expect(humanError(['WARNING: something', 'ERROR: Unsupported URL: https://x'], 1)).toBe(
      'Unsupported URL: https://x'
    )
  })

  it('falls back to the last line, then to the exit code', () => {
    expect(humanError(['something odd happened'], 2)).toBe('something odd happened')
    expect(humanError([], 3)).toBe('yt-dlp exited with code 3')
  })
})

describe('instrumental and vocal — an audio download with a split inside the job', () => {
  const link = parseLink(URL)!

  it('is an audio download as far as yt-dlp is concerned', () => {
    for (const kind of ['instrumental', 'vocal'] as const) {
      expect(downloadKind(kind)).toBe('audio')
      const b = build({ kind })
      expect(b.args, kind).toContain('-x')
      expect(b.after('--audio-format'), kind).toBe('m4a')
      expect(b.args, kind).not.toContain('--merge-output-format')
    }
    expect(downloadKind('audio')).toBe('audio')
    expect(downloadKind('video')).toBe('video')
  })

  it('shares the download with plain audio, so the song is fetched once', () => {
    // The split is a second, separately cached step. Asking for the song and
    // then its instrumental must not download it twice.
    const audio = outputStem(link, { url: URL, kind: 'audio', quality: '1080p' })
    expect(outputStem(link, { url: URL, kind: 'instrumental', quality: '1080p' })).toBe(audio)
    expect(outputStem(link, { url: URL, kind: 'vocal', quality: '1080p' })).toBe(audio)
  })

  it('knows which choices need the stems step', () => {
    expect(needsStems('instrumental')).toBe(true)
    expect(needsStems('vocal')).toBe(true)
    expect(needsStems('audio')).toBe(false)
    expect(needsStems('video')).toBe(false)
  })
})
