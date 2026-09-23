import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildRenderPlan, clipsForRange, encodeSpecFor } from '@shared/render/plan'
import {
  DEFAULT_ENCODE,
  encoderArgs,
  offeredEncoders,
  usableEncoder,
  type EncodeSpec
} from '@shared/render/encode'
import {
  BUILT_IN_PRESETS,
  DEFAULT_CHOICE,
  encodeSpecOf,
  saneChoice,
  sanePreset
} from '@shared/render/presets'
import { listedEncoders } from '../src/main/render/encoders'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * B2: the export has a shape. The plan's half of it — the encoder tail, the
 * container, the range — and the choices that feed it. What actually comes out
 * of ffmpeg is measured in integration/exportShape.int.test.ts.
 */

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a1', path: '/media/talk.mp4', name: 'talk.mp4', kind: 'video', durationFrames: 3000,
  width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, size: 1, ...over
})
const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: 90, inPoint: 0, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
})
/** Loudness off unless asked for, so the audio tail reads as the mix. */
function project(clips: Clip[] = [clip()], loudness?: number): Project {
  const empty = emptyProject()
  const { loudness: _off, ...settings } = empty.settings
  return {
    ...empty,
    settings: loudness === undefined ? settings : { ...settings, loudness },
    assets: [asset()],
    clips
  }
}
const args = (request: Parameters<typeof buildRenderPlan>[0]): string[] => buildRenderPlan(request).args
const argsOf = (request: Parameters<typeof buildRenderPlan>[0]): string => args(request).join(' ')
const graph = (a: string[]): string => a[a.indexOf('-filter_complex') + 1]
/** Everything after the graph's `-t` — the encoder tail, in order. */
const tail = (a: string[]): string[] => a.slice(a.lastIndexOf('-t') + 2)

describe('the encoder tail', () => {
  it('is exactly the export it always was when nothing is asked for', () => {
    // Byte-for-byte the old fixed block, plus the container named outright.
    expect(tail(args({ project: project(), outputPath: '/o/x.mp4' }))).toEqual([
      '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', '/o/x.mp4'
    ])
  })

  it('keeps the old crf and preset working when no spec is given', () => {
    const t = tail(args({ project: project(), outputPath: '/o/x.mp4', crf: 26, preset: 'slow' }))
    expect(t.slice(0, 6)).toEqual(['-c:v', 'libx264', '-crf', '26', '-preset', 'slow'])
    // A preset name ffmpeg would not know falls back rather than failing there.
    expect(encodeSpecFor({ preset: 'ludicrous' }).preset).toBe(DEFAULT_ENCODE.preset)
  })

  it('is encoderArgs, verbatim, when a spec is given', () => {
    const spec: EncodeSpec = {
      encoder: 'libx265', quality: { mode: 'bitrate', kbps: 8000 }, preset: 'fast',
      audioKbps: 320, container: 'mov'
    }
    const a = args({ project: project(), outputPath: '/o/x.mov', encode: spec })
    // The same function the encoder probe calls — so the probe proves THIS.
    expect(tail(a)).toEqual([...encoderArgs(spec, 1920 * 1080), '-f', 'mov', '/o/x.mov'])
  })

  it('names the container, so a .mp4 name cannot put ProRes in an MP4', () => {
    const spec: EncodeSpec = { ...DEFAULT_ENCODE, encoder: 'prores_ks', container: 'mp4' }
    const t = tail(args({ project: project(), outputPath: '/o/typed-before-switching.mp4', encode: spec }))
    expect(t.slice(-3)).toEqual(['-f', 'mov', '/o/typed-before-switching.mp4'])
  })

  it('sizes a CRF-derived bitrate by the canvas actually rendered', () => {
    const spec: EncodeSpec = { ...DEFAULT_ENCODE, encoder: 'h264_videotoolbox' }
    const at = (canvas: { width: number; height: number }): number => {
      const t = tail(args({ project: project(), outputPath: '/o/x.mp4', encode: spec, canvas }))
      return Number(t[t.indexOf('-b:v') + 1].replace('k', ''))
    }
    // Four times the pixels, about four times the bitrate.
    expect(at({ width: 3840, height: 2160 }) / at({ width: 1920, height: 1080 })).toBeCloseTo(4, 1)
  })
})

describe('a range export', () => {
  const three = (): Clip[] => [
    clip({ id: 'a', start: 0, duration: 30 }),
    clip({ id: 'b', start: 30, duration: 30 }),
    clip({ id: 'c', start: 60, duration: 30 })
  ]

  it('drops every clip wholly outside it, and keeps one that straddles an edge', () => {
    const plan = buildRenderPlan({ project: project(three()), outputPath: '/o/x.mp4', range: { start: 35, end: 55 } })
    expect(plan.clips.map((e) => e.clip.id)).toEqual(['b'])
    const straddling = buildRenderPlan({ project: project(three()), outputPath: '/o/x.mp4', range: { start: 20, end: 70 } })
    expect(straddling.clips.map((e) => e.clip.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('is exactly as long as the range, and says so to the progress bar', () => {
    const plan = buildRenderPlan({ project: project(three()), outputPath: '/o/x.mp4', range: { start: 20, end: 70 } })
    expect(plan.durationFrames).toBe(50)
    const a = plan.args
    expect(a[a.lastIndexOf('-t') + 1]).toBe((50 / 30).toFixed(6))
  })

  it('trims the front off the finished picture and the finished mix', () => {
    const g = graph(args({ project: project(three()), outputPath: '/o/x.mp4', range: { start: 20, end: 70 } }))
    const from = (20 / 30).toFixed(6)
    expect(g).toContain(`trim=start=${from},setpts=PTS-STARTPTS,format=yuv420p[vout]`)
    expect(g).toContain(`atrim=start=${from},asetpts=PTS-STARTPTS[aout]`)
    // The graph runs to the out point, not to the end of the edit.
    expect(g).toContain(`color=c=black:s=1920x1080:r=30:d=${(70 / 30).toFixed(6)}`)
  })

  it('trims the mix BEFORE loudness, so loudnorm never hears the silence before the in point', () => {
    const g = graph(args({ project: project(three(), -14), outputPath: '/o/x.mp4', range: { start: 20, end: 70 } }))
    const trim = g.indexOf('atrim=start=')
    const loud = g.indexOf('loudnorm')
    expect(trim).toBeGreaterThan(-1)
    expect(loud).toBeGreaterThan(trim)
  })

  it('adds no trim when it starts at the top, and nothing at all when it is the whole edit', () => {
    const fromTop = args({ project: project(three()), outputPath: '/o/x.mp4', range: { start: 0, end: 45 } })
    expect(graph(fromTop)).not.toContain('trim=start=')
    expect(fromTop[fromTop.lastIndexOf('-t') + 1]).toBe((45 / 30).toFixed(6))
    const whole = args({ project: project(three()), outputPath: '/o/x.mp4', range: { start: 0, end: 90 } })
    expect(whole).toEqual(args({ project: project(three()), outputPath: '/o/x.mp4' }))
  })

  it('keeps the matte a kept clip is cut out through, even when the matte lies outside', () => {
    /*
     * The shape is on screen for the first second; the footage cut out through
     * it runs for three. A range of the last two seconds dropped the shape by
     * time alone, and the footage came out as a plain rectangle — silently,
     * because a missing matte is simply skipped. Found by the B2 review.
     */
    const shaped: Project = {
      ...project([
        clip({ id: 'shape', assetId: 'txt', start: 0, duration: 30, matteOnly: true }),
        clip({ id: 'shot', start: 0, duration: 90, matte: { clipId: 'shape' } }),
        clip({ id: 'later', start: 60, duration: 30 })
      ]),
      assets: [asset(), asset({ id: 'txt', kind: 'image', hasAudio: false, path: '/titles/shape.png' })]
    }
    const range = { start: 40, end: 80 }
    expect(clipsForRange(shaped.clips, range).map((c) => c.id).sort()).toEqual(['later', 'shape', 'shot'])

    const whole = argsOf({ project: shaped, outputPath: '/o/x.mp4' })
    const ranged = argsOf({ project: shaped, outputPath: '/o/x.mp4', range })
    // The shape still reaches the render, and the cut-out is still made.
    expect(ranged).toContain('/titles/shape.png')
    const merges = (a: string): number => (a.match(/alphamerge/g) ?? []).length
    expect(merges(ranged)).toBeGreaterThan(0)
    expect(merges(ranged)).toBe(merges(whole))
  })

  it('still drops a clip wholly outside that nothing uses', () => {
    const clips = [clip({ id: 'early', start: 0, duration: 30 }), clip({ id: 'kept', start: 40, duration: 30 })]
    expect(clipsForRange(clips, { start: 35, end: 80 }).map((c) => c.id)).toEqual(['kept'])
  })

  it('refuses a range with no picture in it, and says what to do', () => {
    const gap = project([clip({ id: 'a', start: 0, duration: 30 }), clip({ id: 'z', start: 90, duration: 30 })])
    expect(() => buildRenderPlan({ project: gap, outputPath: '/o/x.mp4', range: { start: 40, end: 80 } })).toThrow(
      /in and out points/
    )
  })
})

describe('the delivery choice', () => {
  it('fills a preset saved before B2 with the export it always made', () => {
    const old = sanePreset(
      { id: 'mine', name: 'Old one', aspect: '9:16', crf: 22, preset: 'fast', loudness: -14, captions: true, suffix: '-x' },
      BUILT_IN_PRESETS[0]
    )
    expect(old.resolution).toBe('1080p')
    expect(old.encoder).toBe('libx264')
    expect(old.bitrateKbps).toBeNull()
    expect(old.audioKbps).toBe(192)
    expect(old.container).toBe('mp4')
    // And what it had is kept.
    expect(old.crf).toBe(22)
    expect(old.preset).toBe('fast')
  })

  it('brings a hand-edited choice back into range', () => {
    const wild = saneChoice({
      resolution: '8k' as never, encoder: 'libaom' as never, bitrateKbps: 9e9,
      audioKbps: 999, container: 'avi' as never, crf: -5
    })
    expect(wild.resolution).toBe(DEFAULT_CHOICE.resolution)
    expect(wild.encoder).toBe(DEFAULT_CHOICE.encoder)
    expect(wild.bitrateKbps).toBe(100_000)
    // A number is taken to the nearest bitrate offered; nonsense to the default.
    expect(wild.audioKbps).toBe(256)
    expect(saneChoice({ audioKbps: 'loud' as never }).audioKbps).toBe(DEFAULT_CHOICE.audioKbps)
    expect(wild.container).toBe(DEFAULT_CHOICE.container)
    expect(wild.crf).toBeGreaterThanOrEqual(14)
  })

  it('puts ProRes in a .mov whatever was stored', () => {
    expect(saneChoice({ encoder: 'prores_ks', container: 'mp4' }).container).toBe('mov')
    expect(encodeSpecOf({ ...DEFAULT_CHOICE, encoder: 'prores_ks' }).container).toBe('mov')
  })

  it('turns a choice into a spec: bitrate when one is set, constant quality when not', () => {
    expect(encodeSpecOf({ ...DEFAULT_CHOICE, crf: 18 }).quality).toEqual({ mode: 'crf', crf: 18 })
    expect(encodeSpecOf({ ...DEFAULT_CHOICE, bitrateKbps: 8000 }).quality).toEqual({ mode: 'bitrate', kbps: 8000 })
  })
})

describe('the audio bitrates offered', () => {
  it('turns a stored 320 into 256 — the encoder writes less at 320 than at 256', () => {
    // Measured: 248 kb/s asked for 320k, 260 asked for 256k.
    expect(saneChoice({ audioKbps: 320 }).audioKbps).toBe(256)
    const t = tail(args({ project: project(), outputPath: '/o/x.mp4', encode: { ...DEFAULT_ENCODE, audioKbps: 320 } }))
    expect(t[t.indexOf('-b:a') + 1]).toBe('256k')
    expect(saneChoice({ audioKbps: 128 }).audioKbps).toBe(128)
  })
})

describe('an encoder this machine cannot run', () => {
  it('falls back to software H.264, and says which and why', () => {
    const got = usableEncoder('h264_nvenc', [{ id: 'h264_nvenc', ok: false, reason: 'No NVENC capable devices found' }])
    expect(got.encoder).toBe('libx264')
    expect(got.note).toMatch(/NVIDIA/)
    expect(got.note).toMatch(/No NVENC capable devices found/)
  })

  it('uses it when the probe said it works, and never questions software H.264', () => {
    expect(usableEncoder('libx265', [{ id: 'libx265', ok: true }])).toEqual({ encoder: 'libx265', note: null })
    expect(usableEncoder('libx264', null)).toEqual({ encoder: 'libx264', note: null })
    // An encoder the probe never mentioned is not assumed to work.
    expect(usableEncoder('prores_ks', []).encoder).toBe('libx264')
  })
})

describe('which encoders are offered', () => {
  it('only the ones the probe encoded with — software H.264 always', () => {
    const ids = (available: Parameters<typeof offeredEncoders>[0]): string[] =>
      offeredEncoders(available).map((e) => e.id)
    expect(ids(null)).toEqual(['libx264'])
    expect(ids([])).toEqual(['libx264'])
    // VideoToolbox is LISTED on the bundled macOS build and fails to open.
    const offered = ids([
      { id: 'libx265', ok: true },
      { id: 'h264_videotoolbox', ok: false },
      { id: 'prores_ks', ok: true }
    ])
    expect(offered).toContain('libx265')
    expect(offered).toContain('prores_ks')
    expect(offered).not.toContain('h264_videotoolbox')
    expect(offered).toContain('libx264')
  })
})

describe('reading -encoders', () => {
  it('takes the names, not the descriptions or the legend', () => {
    const output = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
      ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
      ' VF.... prores_ks            Apple ProRes (iCodec Pro) (codec prores)',
      ' A....D aac                  AAC (Advanced Audio Coding)'
    ].join('\n')
    const names = listedEncoders(output)
    expect(names.has('libx264')).toBe(true)
    expect(names.has('h264_videotoolbox')).toBe(true)
    expect(names.has('prores_ks')).toBe(true)
    expect(names.has('aac')).toBe(true)
    // The legend's "=" rows are not encoders.
    expect(names.has('=')).toBe(false)
  })
})

/* ------------------------------------------------------------ the wiring */

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('the export button sends what the panel shows', () => {
  const inspector = source('src/renderer/src/components/Inspector.tsx')
  const at = inspector.indexOf('const onExport = useCallback(')
  const end = inspector.indexOf('}, [aspect, notify, useRange, style])', at)
  const onExport = inspector.slice(at, end)

  it('passes the spec, the range and the export canvas', () => {
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    expect(onExport).toContain('encode: spec,')
    expect(onExport).toContain('range: marked ?? undefined,')
    expect(onExport).toContain('const canvas = exportCanvas(wanted, choice.resolution)')
  })

  it('applies a preset’s loudness and captions to what is rendered', () => {
    // Presets stored both, and the export never applied either.
    expect(onExport).toContain('loudness: preset.loudness ?? undefined')
    expect(onExport).toContain('enabled: preset.captions')
    expect(onExport).toContain('project: exported,')
  })

  it('falls back from an encoder the machine cannot run', () => {
    expect(onExport).toContain('usableEncoder(choice.encoder,')
  })

  it('re-reads the range toggle when it changes', () => {
    // A toggle missing from the dependencies is a button that exports with
    // whatever it was when the edit last changed — which Draft once did.
    expect(inspector).toContain('}, [aspect, notify, useRange, style])')
  })

  it('has no half-size draft left anywhere in the export path', () => {
    // Removed on request: 720p is the quick export now. Checked by name, so a
    // half-size canvas or a forced CRF cannot come back under another label.
    expect(onExport).not.toMatch(/draft/i)
    expect(onExport).not.toContain('crf: 26')
    expect(inspector).not.toContain('Export draft')
    expect(source('src/shared/render/exportShape.ts')).not.toMatch(/\* \(draft \? 0\.5/)
  })

  it('draws the export’s cards into a copy, never into the edit', () => {
    // The editor's rebake wrote into the project: undo entries, a wiped redo
    // stack, an unsaved project — by pressing Export. Found by the B2 review.
    expect(onExport).toContain('await bakeForExport(useEditor.getState().project, canvas, liveBakers,')
    expect(onExport).not.toContain('rebakeGenerated(')
  })

  it('asks for the encoders again after a failed ask, and not after an answer', () => {
    const store = source('src/renderer/src/store.ts')
    const at = store.indexOf('  loadEncoders: async () => {')
    expect(at).toBeGreaterThan(-1)
    const load = store.slice(at, store.indexOf('\n  },\n', at))
    // Guarded on having been ANSWERED — not on holding a list, which the
    // H.264-only fallback after a failure also does.
    expect(load).toContain('if (encodersProbed) return')
    expect(load.indexOf('encodersProbed = true')).toBeGreaterThan(load.indexOf('await window.forge.encoders()'))
    expect(load.slice(load.indexOf('} catch {'))).not.toContain('encodersProbed = true')
  })

  it('reaches the render: the main process passes encode and range through', () => {
    const ipc = source('src/main/ipc.ts')
    expect(ipc).toContain('encode: request.encode,')
    expect(ipc).toContain('range: request.range,')
    expect(ipc).toContain("ipcMain.handle('render:encoders', () => probeEncoders())")
    // And the save dialog offers a .mov.
    expect(ipc).toContain("{ name: 'QuickTime movie', extensions: ['mov'] }")
  })
})
