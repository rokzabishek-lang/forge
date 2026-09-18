import { describe, it, expect } from 'vitest'
import { linkProblem, LINK_PROBLEM_TEXT, parseLink, youtubeId } from '@shared/ingest/url'
import { formatFor, outputTemplate, QUALITIES } from '@shared/ingest/format'
import {
  createIngestProgress,
  parseProgressLine,
  PROGRESS_TEMPLATE
} from '@shared/ingest/progress'
import {
  formatMark,
  offsetIntoDownload,
  PAD_MS,
  parseMark,
  sectionPlan,
  trimToRequestedRange
} from '@shared/ingest/section'
import { VIDEO_EXT, AUDIO_EXT } from '@shared/media'

describe('reading a pasted link', () => {
  it('takes the id out of every shape YouTube uses', () => {
    const id = 'dQw4w9WgXcQ'
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `  https://www.youtube.com/watch?v=${id}  `
    ]) {
      expect(youtubeId(url), url).toBe(id)
    }
  })

  it('survives the parameters a real copied link carries', () => {
    const id = 'dQw4w9WgXcQ'
    expect(youtubeId(`https://www.youtube.com/watch?v=${id}&list=PLabc&index=3&t=42s`)).toBe(id)
    expect(youtubeId(`https://youtu.be/${id}?si=trackingnonsense&t=90`)).toBe(id)
  })

  it('canonicalises, so one video pasted three ways is one download', () => {
    const id = 'dQw4w9WgXcQ'
    const want = `https://www.youtube.com/watch?v=${id}`
    expect(parseLink(`https://youtu.be/${id}?si=x`)?.url).toBe(want)
    expect(parseLink(`https://m.youtube.com/watch?v=${id}&t=9`)?.url).toBe(want)
    expect(parseLink(`https://www.youtube.com/shorts/${id}`)?.url).toBe(want)
  })

  it('does not find an id in the middle of an unrelated string', () => {
    /*
     * The regex-only version of this function is a known trap: eleven word
     * characters occur constantly, so it reports a video id for links that have
     * nothing to do with YouTube. Parsing the URL first is what prevents it.
     */
    expect(youtubeId('https://example.com/dQw4w9WgXcQ')).toBeNull()
    expect(youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(youtubeId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull()
  })

  it('rejects an id of the wrong length rather than truncating it', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=tooshort')).toBeNull()
    expect(youtubeId('https://youtu.be/waaaaaaaaaaytoolong')).toBeNull()
  })

  it('refuses anything that is not an http(s) URL', () => {
    for (const bad of ['', '   ', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(parseLink(bad), bad).toBeNull()
    }
  })

  it('accepts a non-YouTube link as generic rather than pretending it cannot', () => {
    // yt-dlp reads over a thousand sites. Refusing them would be the app
    // inventing a limit the tool underneath does not have.
    const link = parseLink('https://vimeo.com/123456789')
    expect(link?.kind).toBe('generic')
    expect(link?.videoId).toBeNull()
    expect(link?.url).toContain('vimeo.com')
  })

  it('produces a key that is legal on Windows and safe in a filtergraph', () => {
    /*
     * The whole reason the id is used instead of the title. Windows forbids
     * < > : " | ? * and a filtergraph needs backslashes for , [ ] ; : = and '.
     * A key containing none of them sidesteps both problems at once.
     */
    const keys = [
      parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!.key,
      parseLink('https://vimeo.com/123456789?q=a:b|c')!.key,
      parseLink('https://example.com/a b/c?d=e&f="g"')!.key
    ]
    for (const key of keys) {
      expect(key, key).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(key.length).toBeGreaterThan(0)
      expect(key.length).toBeLessThanOrEqual(48)
    }
  })

  it('never returns an empty key, which would make a dotfile', () => {
    expect(parseLink('https://example.com/')!.key).toMatch(/^example-com-[0-9a-f]{8}$/)
    expect(parseLink('https://-/')?.key ?? 'download').not.toBe('')
  })

  it('does not collide when two long URLs share a prefix', () => {
    /*
     * A collision here is not a mangled name — it is the second link being
     * served the FIRST link's file as a cache hit. Real sites lay paths out
     * exactly like this, so the readable slug is truncated and a digest of the
     * whole URL is appended.
     */
    const base = 'https://example.com/a/very/long/path/that/goes/on/and/on/segment-'
    const a = parseLink(`${base}one-aaaaaaaaaaaaaaaaaaaa`)!.key
    const b = parseLink(`${base}two-bbbbbbbbbbbbbbbbbbbb`)!.key
    expect(a).not.toBe(b)
    expect(a.slice(0, 40)).toBe(b.slice(0, 40))
  })

  it('refuses a playlist, channel or feed rather than downloading all of it', () => {
    /*
     * --no-playlist does NOT save us: yt-dlp decides `not video_id` before it
     * reads that flag, so a collection URL extracts everything. Against one
     * output template that means entry 1's bytes under entry N's title, with
     * nothing to show anything went wrong.
     */
    for (const url of [
      'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
      'https://www.youtube.com/@SomeChannel/videos',
      'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
      'https://www.youtube.com/c/SomeChannel',
      'https://www.youtube.com/user/SomeUser',
      'https://www.youtube.com/feed/subscriptions',
      'https://soundcloud.com/artist/sets/an-album'
    ]) {
      expect(parseLink(url), url).toBeNull()
    }
  })

  it('still takes a video that merely sits inside a playlist', () => {
    const link = parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=3')
    expect(link?.videoId).toBe('dQw4w9WgXcQ')
  })

  it('refuses a string that yt-dlp would read as an option', () => {
    expect(parseLink('--version')).toBeNull()
    expect(parseLink('-o /tmp/x')).toBeNull()
  })

  it('names the output from the key and lets yt-dlp choose the extension', () => {
    expect(outputTemplate('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ.%(ext)s')
  })
})

describe('the quality ladder', () => {
  it('offers exactly what the sheet drew', () => {
    expect([...QUALITIES]).toEqual(['2160p', '1080p', '720p', '480p'])
  })

  it('expresses size as a SORT, not a height filter', () => {
    /*
     * The bug this file missed twice, in two different forms.
     *
     * First: yt-dlp's `/` is fallback-only, so an H.264-first chain was
     * satisfied by a 1080p stream and 4K silently returned 1080p.
     *
     * Then, worse: `height<=?1080` is FALSE for every vertical video, because
     * a 1080p reel is 1080 wide and 1920 tall. Every YouTube Short and every
     * Instagram reel answered "Requested format is not available" — in an app
     * whose whole subject is short-form vertical video.
     *
     * Both came from choosing with filters and branches. `-S res:N` ranks
     * every permitted format instead, and `res` is the LOWER of height and
     * width, which is what 1080p means for a reel. What yt-dlp actually picks
     * is asserted against the real binary in
     * tests/integration/ytdlpFormat.int.test.ts; this only pins the shape.
     */
    for (const q of QUALITIES) {
      const { selector, sort } = formatFor('video', q)
      expect(selector, q).not.toContain('height')
      expect(sort, q).toContain('res:')
    }
    expect(formatFor('video', '2160p').sort).toContain('res:2160')
    expect(formatFor('video', '480p').sort).toContain('res:480')
  })

  it('prefers H.264 and AAC without demanding them', () => {
    /*
     * A preference, not a filter. H.264 plus AAC is what every ffmpeg since
     * 2012 can mux, so it is ranked first — but a site serving nothing else
     * must still download, which a hard `vcodec^=avc1` branch cannot promise.
     */
    const { selector, sort } = formatFor('video', '1080p')
    expect(sort).toContain('vcodec:h264')
    expect(sort).toContain('acodec:m4a')
    expect(selector).not.toContain('vcodec^=avc1')
  })

  it('EXCLUDES AV1 at every quality, because the Windows ffmpeg predates it', () => {
    /*
     * The load-bearing assertion in this file. Our Windows ffmpeg is a master
     * snapshot from 2018-12-17 and AV1-in-mp4 muxing came later, while YouTube
     * now offers av01 at every size. Without this, "best" picks the one stream
     * that works on the machine this was written on and fails on the machine it
     * ships to — the exact shape of the three bugs in EFFECTS.md section 25.
     */
    for (const q of QUALITIES) {
      const { selector } = formatFor('video', q)
      expect(selector, q).toContain('vcodec!*=av01')

      /*
       * Every branch, including the last-resort one. A single pre-muxed AV1
       * stream needs no merging and so slips past the muxing argument — but the
       * file still has to be DECODED for the preview and every render, and the
       * 2018 build cannot. Checked branch by branch because the hole this test
       * found was in exactly one of them.
       */
      for (const branch of selector.split('/')) {
        const restricted = branch.includes('vcodec^=avc1') || branch.includes('vcodec!*=av01')
        expect(restricted, `${q}: unrestricted branch "${branch}" could select AV1`).toBe(true)
      }
    }
  })

  it('asks for the combined stream before the pre-muxed one', () => {
    /*
     * Order still matters in `-f`, even though size no longer lives there:
     * separate streams give the better picture where a site has them, and the
     * single-file branch is the fallback for everywhere that does not.
     */
    const branches = formatFor('video', '1080p').selector.split('/')
    expect(branches[0]).toContain('+')
    expect(branches.at(-1)).not.toContain('+')
  })

  it('always leaves a branch that works without separate streams', () => {
    /*
     * Most of the web is not YouTube. Instagram, TikTok and the rest serve one
     * already-muxed file with no separate audio stream, and a selector that
     * only knows how to combine two streams downloads nothing from any of them.
     */
    for (const q of QUALITIES) {
      const branches = formatFor('video', q).selector.split('/')
      expect(branches.some((b) => !b.includes('+')), q).toBe(true)
    }
  })

  it('never merges for audio, because one stream is one file', () => {
    const audio = formatFor('audio', '1080p')
    expect(audio.mergeFormat).toBeNull()
    expect(audio.selector).not.toContain('+')
  })

  it('produces an extension the app will actually import', () => {
    /*
     * probeFile throws before it ever spawns ffprobe if the extension is not in
     * these lists, so a download that lands as something unrecognised fails
     * with "Unsupported file type" after the whole transfer.
     */
    for (const q of QUALITIES) {
      expect(VIDEO_EXT, q).toContain(formatFor('video', q).expectedExt)
    }
    expect(AUDIO_EXT).toContain(formatFor('audio', '1080p').expectedExt)
  })

  it('is stable — the selector is not rebuilt differently each call', () => {
    for (const q of QUALITIES) {
      expect(formatFor('video', q)).toEqual(formatFor('video', q))
    }
  })
})

describe('yt-dlp progress', () => {
  const line = (
    status: string,
    downloaded: string,
    total: string,
    estimate = 'NA',
    speed = 'NA',
    eta = 'NA'
  ): string => `@forge@${status}|${downloaded}|${total}|${estimate}|${speed}|${eta}`

  it('asks for a template with a marker and only unambiguous fields', () => {
    expect(PROGRESS_TEMPLATE).toContain('@forge@')
    expect(PROGRESS_TEMPLATE).toContain('%(progress.status)s')
    // Never the title or filename — those can contain anything, including a pipe.
    expect(PROGRESS_TEMPLATE).not.toContain('title')
    expect(PROGRESS_TEMPLATE).not.toContain('filename')
  })

  it('ignores every other thing yt-dlp and ffmpeg print', () => {
    for (const noise of [
      '[youtube] Extracting URL: https://www.youtube.com/watch?v=x',
      'WARNING: unable to extract something',
      '[download] Destination: dQw4w9WgXcQ.f137.mp4',
      'frame=  120 fps=0.0 q=-1.0 size=    1024kB time=00:00:04.00',
      '',
      '   '
    ]) {
      expect(parseProgressLine(noise), noise).toBeNull()
    }
  })

  it('reads a normal line', () => {
    const parsed = parseProgressLine(line('downloading', '5000', '10000', 'NA', '1500.5', '3'))
    expect(parsed).toEqual({
      status: 'downloading',
      downloadedBytes: 5000,
      totalBytes: 10000,
      speedBps: 1500.5,
      etaSeconds: 3
    })
  })

  it('falls back to the estimate when the real total is unknown', () => {
    const parsed = parseProgressLine(line('downloading', '500', 'NA', '4096'))
    expect(parsed?.totalBytes).toBe(4096)
  })

  it('treats NA and None as unknown rather than as zero', () => {
    // Number('NA') is NaN, but Number('') is 0 — which would render a real
    // speed of "0 B/s" and an ETA of "now" forever.
    const parsed = parseProgressLine(line('downloading', 'NA', 'None', 'NA', 'NA', 'NA'))
    expect(parsed?.downloadedBytes).toBeNull()
    expect(parsed?.totalBytes).toBeNull()
    expect(parsed?.speedBps).toBeNull()
  })

  it('does not mistake a partial or malformed line for progress', () => {
    expect(parseProgressLine('@forge@downloading|5000')).toBeNull()
    expect(parseProgressLine('@forge@weird|1|2|3|4|5')).toBeNull()
  })

  describe('folded into one bar', () => {
    it('does not reset when the second stream starts', () => {
      /*
       * THE case this exists for. Above 720p, YouTube stores video and audio
       * separately, so yt-dlp runs two downloads and each reports its own
       * 0-to-100%. Read naively the bar fills, resets, and fills again.
       */
      const p = createIngestProgress()
      p.push(line('downloading', '50000000', '100000000'))
      expect(p.state().progress).toBeCloseTo(0.5, 2)

      p.push(line('downloading', '100000000', '100000000'))
      p.push(line('finished', '100000000', '100000000'))
      const afterVideo = p.state().progress!

      // Audio begins: a fresh stream reporting a few bytes of a few megabytes.
      const now = p.push(line('downloading', '100000', '3000000'))!
      expect(now.progress).not.toBeLessThan(afterVideo)
      expect(now.completed).toBe(1)
    })

    it('never goes backwards, even though the true fraction does', () => {
      /*
       * The audio stream's size is unknown until it starts, so the denominator
       * grows and the honest fraction drops — 100MB of 100MB becomes 100 of
       * 103. A bar going backwards is the more alarming of the two bugs, so the
       * figure is clamped. Slightly optimistic in the middle, exact at the ends.
       */
      const p = createIngestProgress()
      const seen: number[] = []
      for (const l of [
        line('downloading', '100000000', '100000000'),
        line('finished', '100000000', '100000000'),
        line('downloading', '1000', '3000000'),
        line('downloading', '1500000', '3000000'),
        line('downloading', '3000000', '3000000'),
        line('finished', '3000000', '3000000')
      ]) {
        const s = p.push(l)
        if (s?.progress != null) seen.push(s.progress)
      }
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i], `step ${i} of ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(seen[i - 1])
      }
      expect(seen.at(-1)).toBeCloseTo(1, 5)
    })

    it('reports null rather than zero when it cannot say', () => {
      // A live stream or a server with no content-length has no total. Zero
      // would be a lie that renders as a bar stuck at the left.
      const p = createIngestProgress()
      const s = p.push(line('downloading', '5000', 'NA', 'NA'))
      expect(s?.progress).toBeNull()
    })

    it('does not claim the job is done when the first stream finishes', () => {
      const p = createIngestProgress()
      p.push(line('downloading', '5000', '10000'))
      const s = p.push(line('finished', '10000', '10000'))!
      expect(s.completed).toBe(1)
      expect(s.progress).toBeLessThan(1)
    })

    it('drops the speed and ETA once a stream ends, rather than freezing them', () => {
      const p = createIngestProgress()
      p.push(line('downloading', '5000', '10000', 'NA', '2000', '5'))
      const s = p.push(line('finished', '10000', '10000'))!
      expect(s.speedBps).toBeNull()
      expect(s.etaSeconds).toBeNull()
    })

    it('ignores noise without disturbing the running figure', () => {
      const p = createIngestProgress()
      p.push(line('downloading', '5000', '10000'))
      const before = p.state()
      expect(p.push('[download] Destination: x.f137.mp4')).toBeNull()
      expect(p.state()).toEqual(before)
    })
  })
})

describe('clipping a range before the download', () => {
  it('asks for nothing when there is no range', () => {
    const plan = sectionPlan(null, false)
    expect(plan.args).toEqual([])
    expect(plan.requested).toBeNull()
  })

  it('cuts exactly when asked, and says it re-encodes to do it', () => {
    const plan = sectionPlan({ startMs: 10_000, endMs: 25_500 }, true)
    expect(plan.args).toEqual([
      '--download-sections',
      '*10.000-25.500',
      '--force-keyframes-at-cuts'
    ])
    expect(plan.approximate).toBe(false)
  })

  it('pads outward on the fast path, so the marked material is definitely inside', () => {
    /*
     * Without --force-keyframes-at-cuts the cut lands on the nearest keyframe
     * at or before the mark, which can be seconds early. Padding means the
     * boundaries are loose but nothing the user marked is missing — and the
     * ends get placed exactly on the timeline afterwards.
     */
    const plan = sectionPlan({ startMs: 60_000, endMs: 90_000 }, false)
    expect(plan.args).toEqual(['--download-sections', '*50.000-100.000'])
    expect(plan.approximate).toBe(true)
    expect(plan.requested).toEqual({ startMs: 60_000, endMs: 90_000 })
  })

  it('never asks for a negative start near the top of a video', () => {
    const plan = sectionPlan({ startMs: 2_000, endMs: 8_000 }, false)
    expect(plan.args[1]).toBe('*0.000-18.000')
    expect(plan.args[1]).not.toContain('-8.000-')
  })

  it('knows where the range sits inside a padded download', () => {
    // Full pad once there is room for it...
    expect(offsetIntoDownload({ startMs: 60_000, endMs: 90_000 })).toBe(PAD_MS)
    // ...and only what fitted, near the start. Getting this wrong puts every
    // clip taken from the first ten seconds out by the missing padding.
    expect(offsetIntoDownload({ startMs: 2_000, endMs: 8_000 })).toBe(2_000)
    expect(offsetIntoDownload({ startMs: 0, endMs: 5_000 })).toBe(0)
  })

  it('repairs a dragged-backwards slider rather than downloading nothing', () => {
    const plan = sectionPlan({ startMs: 90_000, endMs: 60_000 }, true)
    expect(plan.args[1]).toBe('*60.000-90.000')
  })

  it('falls back to the whole video for a zero-length range', () => {
    // A UI slip, not an instruction. Downloading nothing looks like a failure.
    expect(sectionPlan({ startMs: 5_000, endMs: 5_000 }, true).args).toEqual([])
  })

  it('is finer than any frame rate, so a handle never lands between frames', () => {
    const plan = sectionPlan({ startMs: 1_001, endMs: 2_002 }, true)
    expect(plan.args[1]).toBe('*1.001-2.002')
  })
})

describe('trimming the clip to what was marked', () => {
  it('removes exactly the padding the fast path added', () => {
    // 60s–90s at 30fps: the pad puts 10s in front, so the clip starts 300
    // frames in and runs the 900 frames that were actually marked.
    expect(trimToRequestedRange({ startMs: 60_000, endMs: 90_000 }, 1500, 30)).toEqual({
      inPoint: 300,
      duration: 900
    })
  })

  it('only removes the padding that fitted, near the start of a video', () => {
    // 2s in, so there was only 2s of room for a 10s pad.
    expect(trimToRequestedRange({ startMs: 2_000, endMs: 8_000 }, 600, 30)).toEqual({
      inPoint: 60,
      duration: 180
    })
    expect(trimToRequestedRange({ startMs: 0, endMs: 5_000 }, 450, 30)).toEqual({
      inPoint: 0,
      duration: 150
    })
  })

  it('never points past the end of a download shorter than the pad', () => {
    /*
     * The case that produced a clip showing nothing: an unclamped in-point ran
     * past the media it was cut from. A short or truncated download must still
     * yield a playable clip.
     */
    const short = trimToRequestedRange({ startMs: 60_000, endMs: 90_000 }, 30, 30)
    expect(short.inPoint).toBeLessThan(30)
    expect(short.inPoint + short.duration).toBeLessThanOrEqual(30)
    expect(short.duration).toBeGreaterThanOrEqual(1)
  })

  it('never returns a zero-length clip', () => {
    for (const total of [1, 2, 5, 60, 1500]) {
      const t = trimToRequestedRange({ startMs: 60_000, endMs: 90_000 }, total, 30)
      expect(t.duration, `total=${total}`).toBeGreaterThanOrEqual(1)
      expect(t.inPoint, `total=${total}`).toBeGreaterThanOrEqual(0)
    }
  })

  it('repairs a backwards range rather than producing a negative one', () => {
    expect(trimToRequestedRange({ startMs: 90_000, endMs: 60_000 }, 1500, 30)).toEqual(
      trimToRequestedRange({ startMs: 60_000, endMs: 90_000 }, 1500, 30)
    )
  })
})

describe('marks a person types', () => {
  it('reads the shapes people actually write', () => {
    expect(parseMark('90')).toBe(90_000)
    expect(parseMark('1:30')).toBe(90_000)
    expect(parseMark('1:30.5')).toBe(90_500)
    expect(parseMark('01:02:03')).toBe(3_723_000)
    expect(parseMark('  2:05  ')).toBe(125_000)
    expect(parseMark('0')).toBe(0)
  })

  it('refuses what it cannot read instead of quietly meaning zero', () => {
    /*
     * `Number('1:30')` is NaN, and NaN milliseconds reaching
     * --download-sections is how a range silently stops meaning anything. The
     * field says so rather than becoming 0:00.
     */
    for (const bad of ['', '   ', 'abc', '1:', ':30', '1:2:3:4', '1:99', '-5', '1e3', '90s']) {
      expect(parseMark(bad), bad).toBeNull()
    }
  })

  it('round-trips through the formatter', () => {
    for (const ms of [0, 1_500, 90_500, 125_000, 3_723_000]) {
      expect(parseMark(formatMark(ms)), String(ms)).toBe(ms)
    }
  })

  it('grows to hours only when there are hours to show', () => {
    expect(formatMark(90_500)).toBe('1:30.5')
    expect(formatMark(3_723_000)).toBe('1:02:03.0')
  })
})

describe('what is wrong with a pasted link', () => {
  it('gives one answer, which both the panel and the store use', () => {
    expect(linkProblem('')).toBe('empty')
    expect(linkProblem('   ')).toBe('empty')
    expect(linkProblem('hello')).toBe('not-a-link')
    expect(linkProblem('https://y')).toBe('not-a-link')
    expect(linkProblem('https://www.youtube.com/playlist?list=PLabc')).toBe('collection')
    expect(linkProblem('https://www.youtube.com/@channel/videos')).toBe('collection')
    expect(linkProblem('https://youtu.be/dQw4w9WgXcQ')).toBeNull()
  })

  it('does not call a half-typed link a playlist', () => {
    // The two callers used to decide separately and could contradict each
    // other about the same text at the same moment.
    for (const partial of ['h', 'http', 'https:/', 'https://', 'https://www.you']) {
      expect(linkProblem(partial), partial).not.toBe('collection')
    }
  })

  it('has a message for every problem it can report', () => {
    for (const problem of ['empty', 'not-a-link', 'collection'] as const) {
      expect(LINK_PROBLEM_TEXT[problem].length).toBeGreaterThan(10)
    }
  })
})

describe('links from sites that are not YouTube', () => {
  it('accepts a TikTok video, which puts a handle in its path', () => {
    /*
     * `@[^/]+` was in the collection list for `youtube.com/@channel`, and it
     * refused every TikTok video link with "That is a playlist, channel or
     * feed". Depth is what separates them: a profile and its tabs are one or
     * two segments, a video is three.
     */
    const link = parseLink('https://www.tiktok.com/@someone/video/7123456789')
    expect(link?.kind).toBe('generic')
    expect(linkProblem('https://www.tiktok.com/@someone/video/7123456789')).toBeNull()
  })

  it('still refuses a profile and its tabs', () => {
    for (const url of [
      'https://www.youtube.com/@mrbeast',
      'https://www.youtube.com/@mrbeast/videos',
      'https://www.youtube.com/@mrbeast/shorts',
      'https://www.tiktok.com/@someone'
    ]) {
      expect(parseLink(url), url).toBeNull()
      expect(linkProblem(url), url).toBe('collection')
    }
  })

  it('accepts the reel and post shapes people actually paste', () => {
    // None of these is YouTube, and yt-dlp reads well over a thousand sites.
    // Refusing them would be the app inventing a limit the tool does not have.
    for (const url of [
      'https://www.instagram.com/reel/DAbc123XyZ/',
      'https://www.instagram.com/reel/DAbc123XyZ/?igsh=MXY123',
      'https://www.instagram.com/p/DAbc123XyZ/',
      'https://vt.tiktok.com/ZSABC123/',
      'https://x.com/someone/status/1790000000000',
      'https://www.facebook.com/reel/123456789'
    ]) {
      expect(parseLink(url)?.kind, url).toBe('generic')
    }
  })
})
