/**
 * How the finished picture is encoded: codec, quality, audio, container.
 *
 * The encoder tail used to be one fixed block — libx264, CRF 20, yuv420p, AAC at
 * 192k, mp4 — so there was no way to hand a client ProRes for their own grade,
 * upload HEVC at half the size, or use the hardware encoder sitting idle in
 * every laptop. This is that block, as data, per codec FAMILY: the options are
 * not interchangeable (ProRes has no CRF; hardware encoders take a bitrate; x265
 * reads CRF on a different scale), so swapping `-c:v` alone would have produced
 * commands that either fail or quietly ignore half of what they were given.
 *
 * **The probe and the render call the same function.** An encoder is offered
 * only after a real ten-frame encode succeeds on the user's own machine, and
 * that encode is built with `encoderArgs` — the exact arguments the export will
 * use. Listing an encoder is not evidence it works: measured on the bundled
 * macOS build, `h264_videotoolbox` appears in `-encoders` and then fails to
 * open a session (`-12908`). A probe with different arguments from the render
 * would prove something other than what is about to run.
 *
 * Nothing here is newer than the 2018-12-17 Windows floor: `-c:v`, `-b:v`,
 * `-maxrate`, `-bufsize`, `-crf`, `-preset`, `-profile:v`, `-pix_fmt`,
 * `-tag:v`, `-x265-params` and `-movflags` all predate it. Which ENCODERS the
 * Windows binary carries is a build-time fact that no date can answer — which is
 * why they are probed rather than assumed.
 */

export type EncoderId =
  | 'libx264'
  | 'libx265'
  | 'prores_ks'
  | 'h264_videotoolbox'
  | 'hevc_videotoolbox'
  | 'h264_nvenc'
  | 'hevc_nvenc'
  | 'h264_qsv'
  | 'h264_amf'

export type Container = 'mp4' | 'mov'

export type Quality =
  | { mode: 'crf'; crf: number }
  | { mode: 'bitrate'; kbps: number }

export type SpeedPreset = 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow'

export interface EncodeSpec {
  encoder: EncoderId
  quality: Quality
  /** Software encoders only; ignored by the rest. */
  preset?: SpeedPreset
  audioKbps: number
  container: Container
}

export interface EncoderInfo {
  id: EncoderId
  label: string
  /** What someone picks it for, shown beside it. */
  hint: string
  family: 'h264' | 'hevc' | 'prores'
  /** Runs on a GPU or media engine; offered only when the probe succeeds. */
  hardware: boolean
  /** Takes a constant-quality (CRF) setting. Otherwise quality is a bitrate. */
  crf: boolean
  /** A container it cannot go in — ProRes is a QuickTime codec. */
  requires?: Container
}

export const ENCODERS: EncoderInfo[] = [
  {
    id: 'libx264', label: 'H.264', hint: 'Plays everywhere — the safe default',
    family: 'h264', hardware: false, crf: true
  },
  {
    id: 'libx265', label: 'H.265 / HEVC', hint: 'About half the size at the same quality; slower to make',
    family: 'hevc', hardware: false, crf: true
  },
  {
    id: 'prores_ks', label: 'ProRes 422 HQ', hint: 'For handing to an editor or colourist — very large',
    family: 'prores', hardware: false, crf: false, requires: 'mov'
  },
  {
    id: 'h264_videotoolbox', label: 'H.264 (Apple hardware)', hint: 'Much faster on a Mac; a little larger',
    family: 'h264', hardware: true, crf: false
  },
  {
    id: 'hevc_videotoolbox', label: 'HEVC (Apple hardware)', hint: 'Fast and small on a Mac',
    family: 'hevc', hardware: true, crf: false
  },
  {
    id: 'h264_nvenc', label: 'H.264 (NVIDIA)', hint: 'Much faster on an NVIDIA card',
    family: 'h264', hardware: true, crf: false
  },
  {
    id: 'hevc_nvenc', label: 'HEVC (NVIDIA)', hint: 'Fast and small on an NVIDIA card',
    family: 'hevc', hardware: true, crf: false
  },
  {
    id: 'h264_qsv', label: 'H.264 (Intel Quick Sync)', hint: 'Faster on Intel graphics',
    family: 'h264', hardware: true, crf: false
  },
  {
    id: 'h264_amf', label: 'H.264 (AMD)', hint: 'Faster on an AMD card',
    family: 'h264', hardware: true, crf: false
  }
]

export function encoderInfo(id: EncoderId): EncoderInfo {
  return ENCODERS.find((e) => e.id === id) ?? ENCODERS[0]
}

/** The software default everything falls back to, because it is always there. */
export const FALLBACK_ENCODER: EncoderId = 'libx264'

export const CRF_RANGE = { min: 14, max: 34 } as const
export const BITRATE_RANGE = { minKbps: 500, maxKbps: 100_000 } as const
export const AUDIO_KBPS = [128, 192, 256, 320] as const

/**
 * Three named qualities, so nobody has to know what a CRF is.
 *
 * In x264's scale — lower is better and bigger. 18 is where most people stop
 * seeing a difference from the source, 23 is x264's own default, and 28 is for
 * a preview that has to be small.
 */
export const QUALITY_PRESETS = [
  { id: 'high', label: 'High', crf: 18 },
  { id: 'standard', label: 'Standard', crf: 20 },
  { id: 'small', label: 'Small file', crf: 26 }
] as const

/**
 * x265's CRF, from the x264 number the interface shows.
 *
 * The two scales are not the same: x265 at CRF 28 is its own default and looks
 * roughly like x264 at 23. Handing x265 the x264 number unchanged would make
 * every HEVC export needlessly large — the opposite of why anyone picks it — so
 * one slider means one quality, and the offset is applied here.
 */
export const X265_CRF_OFFSET = 5

/**
 * A bitrate for encoders that do not take a CRF, from the CRF the interface
 * holds. Approximate by nature, and only used when someone picked a
 * constant-quality setting and then a hardware encoder: a number derived from
 * their intent is better than a fixed one that ignores it. At 1080p: CRF 18 →
 * ~16 Mbps, 20 → ~12, 26 → ~5.
 */
export function bitrateForCrf(crf: number, pixels: number): number {
  const at1080 = 12_000 * 2 ** ((20 - crf) / 3.3)
  const scaled = at1080 * (pixels / (1920 * 1080))
  return Math.round(Math.max(BITRATE_RANGE.minKbps, Math.min(BITRATE_RANGE.maxKbps, scaled)))
}

/** The container an encoder will actually be written into. */
export function containerFor(encoder: EncoderId, wanted: Container): Container {
  return encoderInfo(encoder).requires ?? wanted
}

function clampCrf(crf: number): number {
  const n = Number.isFinite(crf) ? Math.round(crf) : 20
  return Math.max(CRF_RANGE.min, Math.min(CRF_RANGE.max, n))
}

function clampKbps(kbps: number): number {
  const n = Number.isFinite(kbps) ? Math.round(kbps) : 12_000
  return Math.max(BITRATE_RANGE.minKbps, Math.min(BITRATE_RANGE.maxKbps, n))
}

/**
 * The encoder arguments, in order, for everything after the filter graph.
 *
 * `pixels` is the output canvas area, used only when a CRF has to become a
 * bitrate for an encoder that cannot take one.
 */
export function encoderArgs(spec: EncodeSpec, pixels: number): string[] {
  const info = encoderInfo(spec.encoder)
  const args: string[] = ['-c:v', info.id]

  const kbps =
    spec.quality.mode === 'bitrate'
      ? clampKbps(spec.quality.kbps)
      : bitrateForCrf(clampCrf(spec.quality.crf), pixels)

  if (info.family === 'prores') {
    /*
     * ProRes quality is a PROFILE, not a number: 3 is 422 HQ, which is what an
     * editor asks for when they say "ProRes". 10-bit 4:2:2, because that is what
     * the format is — delivering it at 8-bit 4:2:0 would throw away the one
     * thing it was chosen for.
     */
    args.push('-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0')
  } else if (!info.hardware) {
    const preset = spec.preset ?? 'medium'
    if (spec.quality.mode === 'crf') {
      const crf = clampCrf(spec.quality.crf) + (info.family === 'hevc' ? X265_CRF_OFFSET : 0)
      args.push('-crf', String(crf))
    } else {
      // A cap as well as a target, so "upload at 8 Mbps" means at most 8.
      args.push('-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`)
    }
    args.push('-preset', preset, '-pix_fmt', 'yuv420p')
    if (info.family === 'hevc') {
      // x265 prints a banner and per-frame stats to stderr otherwise, which
      // swamps the progress parser's input.
      args.push('-x265-params', 'log-level=error')
    }
  } else {
    // Hardware encoders: a bitrate, and nothing encoder-specific beyond it —
    // whatever else is set has to be something the 2018 build's version of
    // that encoder accepts, and the probe only proves these exact arguments.
    args.push('-b:v', `${kbps}k`, '-pix_fmt', 'yuv420p')
  }

  /*
   * `hvc1`, not the default `hev1`, for HEVC in an Apple container: QuickTime
   * and iOS refuse to play `hev1` at all, and they are where an HEVC file is
   * most often opened.
   */
  if (info.family === 'hevc') args.push('-tag:v', 'hvc1')

  const audio = AUDIO_KBPS.includes(spec.audioKbps as (typeof AUDIO_KBPS)[number])
    ? spec.audioKbps
    : 192
  args.push('-c:a', 'aac', '-b:a', `${audio}k`)

  // Both containers are QuickTime-family, and both want the index at the front
  // so the file starts playing before it has finished downloading.
  args.push('-movflags', '+faststart')
  return args
}

/** What the render used before any of this existed — the default spec. */
export const DEFAULT_ENCODE: EncodeSpec = {
  encoder: 'libx264',
  quality: { mode: 'crf', crf: 20 },
  preset: 'medium',
  audioKbps: 192,
  container: 'mp4'
}

/**
 * The arguments for a probe encode: ten frames of a test pattern through
 * `encoderArgs` itself. Shared so the main process's probe and the tests build
 * exactly the command the export will run.
 */
export function probeArgs(encoder: EncoderId, output: string): string[] {
  const spec: EncodeSpec = { ...DEFAULT_ENCODE, encoder, container: containerFor(encoder, 'mp4') }
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=0.34',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.34:sample_rate=48000',
    '-shortest',
    ...encoderArgs(spec, 320 * 240),
    output
  ]
}
