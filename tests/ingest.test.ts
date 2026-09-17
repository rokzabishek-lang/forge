import { describe, it, expect } from 'vitest'
import { parseLink, youtubeId } from '@shared/ingest/url'
import { formatFor, outputTemplate, QUALITIES } from '@shared/ingest/format'
import {
  createIngestProgress,
  parseProgressLine,
  PROGRESS_TEMPLATE
} from '@shared/ingest/progress'
import { offsetIntoDownload, PAD_MS, sectionPlan } from '@shared/ingest/section'
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

  it('asks for a stream ABOVE 1080p when 4K was requested', () => {
    /*
     * The bug this file did not catch the first time. yt-dlp's `/` is
     * fallback-only, so the first branch that matches anything wins. YouTube
     * publishes no avc1 above 1080p, so an H.264-first selector was satisfied
     * by the 1080p stream and 4K silently returned a 1080p file — cached under
     * the 4K name, so a retry served it straight back. Verified against the
     * real yt-dlp with a YouTube-shaped info JSON: it chose 137+140 1080 avc1
     * while 313+140 2160 vp09 sat there unused.
     */
    const first = formatFor('video', '2160p').selector.split('/')[0]
    expect(first).toContain('[height>1080]')
    expect(first).not.toContain('vcodec^=avc1')

    // And a video that tops out at 1080p still falls through to H.264, which
    // is the friendliest answer for it — so this is an addition, not a swap.
    expect(formatFor('video', '2160p').selector).toContain('vcodec^=avc1')

    // The lower rungs are unchanged: H.264 first, no height floor.
    for (const q of ['1080p', '720p', '480p'] as const) {
      expect(formatFor('video', q).selector.split('/')[0], q).toContain('vcodec^=avc1')
      expect(formatFor('video', q).selector, q).not.toContain('[height>1080]')
    }
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

  it('prefers H.264 and AAC first, which every ffmpeg since 2012 can mux', () => {
    const { selector } = formatFor('video', '1080p')
    const first = selector.split('/')[0]
    expect(first).toContain('vcodec^=avc1')
    expect(first).toContain('acodec^=mp4a')
  })

  it('caps height non-strictly, so a 720p-only video still downloads', () => {
    // `<=?` not `<=`. Plenty of YouTube is 720p at best, and "you asked for
    // 1080p so you get nothing" is not a useful answer.
    const { selector } = formatFor('video', '1080p')
    expect(selector).toContain('[height<=?1080]')
    expect(selector).not.toContain('[height<=1080]')
  })

  it('asks for a different cap for each rung', () => {
    const caps = QUALITIES.map((q) => formatFor('video', q).selector.match(/height<=\?(\d+)/)![1])
    expect(caps).toEqual(['2160', '1080', '720', '480'])
  })

  it('always leaves a branch that works without separate streams', () => {
    // Some videos have no split streams at all, and this is also the branch
    // that still works if YouTube changes the other two out from under us.
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
