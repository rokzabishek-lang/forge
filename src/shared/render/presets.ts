/**
 * Export settings, saved and re-run.
 *
 * The same ad goes out as 9:16 for reels, 1:1 for the feed and 16:9 for
 * YouTube, and every one of those is the same six decisions made again from
 * memory. Saving them once and picking them by name is the difference between
 * an export being a task and an export being a click — and it is the shape the
 * batch export in `docs/MARKET.md` needs later, where one template goes out to
 * forty clients: a preset IS the unit of work a queue takes.
 *
 * Deliberately NOT part of the project. A preset is how *this person* exports,
 * not what this edit is; putting it in the project file would mean a template
 * bought from someone else arrived carrying their delivery settings.
 */

import type { AspectKey } from './aspect'
import {
  BITRATE_RANGE,
  audioKbpsFor,
  ENCODERS,
  containerFor,
  type Container,
  type EncodeSpec,
  type EncoderId,
  type SpeedPreset
} from './encode'
import { isResolution, type Resolution } from './exportShape'

export interface ExportPreset {
  id: string
  name: string
  /** The canvas it renders to. */
  aspect: AspectKey
  /**
   * x264's quality knob — lower is better and bigger. 20 is the app's normal
   * export, 26 is its Small setting, and the range either side is what people reach
   * for when a platform is strict about size.
   */
  crf: number
  /** x264's speed/size trade. Slower is smaller for the same quality. */
  preset: 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow'
  /** Integrated loudness target in LUFS, or null to leave the mix alone. */
  loudness: number | null
  /** Burn the captions in. Off means the picture has no words on it. */
  captions: boolean
  /** Added to the file name, so three presets do not overwrite each other. */
  suffix: string
  /*
   * B2's delivery choices. A preset file written before them has none of these,
   * and `sanePreset` fills each from the fallback — the export it always made.
   */
  /** 720p, 1080p or 4K, on the aspect's own canvas. */
  resolution: Resolution
  encoder: EncoderId
  /** A target bitrate in kbps, or null for constant quality at `crf`. */
  bitrateKbps: number | null
  audioKbps: number
  container: Container
}

/**
 * The delivery half of a preset — what the Output panel holds between exports.
 *
 * The aspect, the loudness and the captions belong to the edit itself (the
 * project), so the panel reads those from the project; a preset carries all of
 * them because a preset is a whole delivery, applied at once.
 */
export type EncodeChoice = Pick<
  ExportPreset,
  'resolution' | 'encoder' | 'crf' | 'bitrateKbps' | 'preset' | 'audioKbps' | 'container'
>

/** The export this app always made: 1080p H.264 at CRF 20, AAC 192k, MP4. */
export const DEFAULT_CHOICE: EncodeChoice = {
  resolution: '1080p',
  encoder: 'libx264',
  crf: 20,
  bitrateKbps: null,
  preset: 'medium',
  audioKbps: 192,
  container: 'mp4'
}

/** Bring a stored choice into range, field by field, from `fallback`. */
export function saneChoice(raw: Partial<EncodeChoice>, fallback: EncodeChoice = DEFAULT_CHOICE): EncodeChoice {
  const speeds: SpeedPreset[] = ['veryfast', 'faster', 'fast', 'medium', 'slow']
  const crf = typeof raw.crf === 'number' && Number.isFinite(raw.crf) ? Math.round(raw.crf) : fallback.crf
  const encoder = ENCODERS.some((e) => e.id === raw.encoder) ? (raw.encoder as EncoderId) : fallback.encoder
  const wanted: Container = raw.container === 'mov' || raw.container === 'mp4' ? raw.container : fallback.container
  return {
    resolution: isResolution(raw.resolution) ? raw.resolution : fallback.resolution,
    encoder,
    crf: Math.max(CRF_MIN, Math.min(CRF_MAX, crf)),
    bitrateKbps:
      raw.bitrateKbps === null
        ? null
        : typeof raw.bitrateKbps === 'number' && Number.isFinite(raw.bitrateKbps)
          ? Math.max(BITRATE_RANGE.minKbps, Math.min(BITRATE_RANGE.maxKbps, Math.round(raw.bitrateKbps)))
          : fallback.bitrateKbps,
    preset: speeds.includes(raw.preset as SpeedPreset) ? (raw.preset as SpeedPreset) : fallback.preset,
    audioKbps: typeof raw.audioKbps === 'number' ? audioKbpsFor(raw.audioKbps) : fallback.audioKbps,
    // ProRes is a QuickTime codec: whatever was stored, it goes in a .mov.
    container: containerFor(encoder, wanted)
  }
}

/** The encoder settings a choice renders with — see render/encode.ts. */
export function encodeSpecOf(choice: EncodeChoice): EncodeSpec {
  return {
    encoder: choice.encoder,
    quality:
      choice.bitrateKbps === null
        ? { mode: 'crf', crf: choice.crf }
        : { mode: 'bitrate', kbps: choice.bitrateKbps },
    preset: choice.preset,
    audioKbps: choice.audioKbps,
    container: containerFor(choice.encoder, choice.container)
  }
}

export const CRF_MIN = 14
export const CRF_MAX = 34

/**
 * The three that cover almost everything, shipped so the feature is not an
 * empty list on first use.
 *
 * An empty picker teaches nothing — it does not say what a preset IS, and the
 * first thing anyone would have to do is work out what to put in one. These
 * are the three aspect ratios this app exists to serve, at the quality each
 * platform actually wants.
 */
/** What the three built-ins deliver beyond their aspect: the ordinary export. */
const DEFAULT_CHOICE_FIELDS = {
  resolution: DEFAULT_CHOICE.resolution,
  encoder: DEFAULT_CHOICE.encoder,
  bitrateKbps: DEFAULT_CHOICE.bitrateKbps,
  audioKbps: DEFAULT_CHOICE.audioKbps,
  container: DEFAULT_CHOICE.container
}

export const BUILT_IN_PRESETS: ExportPreset[] = [
  {
    id: 'builtin-reel',
    name: 'Reel / TikTok (9:16)',
    aspect: '9:16',
    crf: 20,
    preset: 'medium',
    // -14 LUFS is what every short-form platform normalises to; exporting
    // hotter just means their encoder turns it down, unevenly.
    loudness: -14,
    captions: true,
    suffix: '-9x16',
    ...DEFAULT_CHOICE_FIELDS
  },
  {
    id: 'builtin-feed',
    name: 'Feed square (1:1)',
    aspect: '1:1',
    crf: 20,
    preset: 'medium',
    loudness: -14,
    captions: true,
    suffix: '-1x1',
    ...DEFAULT_CHOICE_FIELDS
  },
  {
    id: 'builtin-wide',
    name: 'YouTube (16:9)',
    aspect: '16:9',
    crf: 19,
    preset: 'slow',
    loudness: -14,
    captions: false,
    suffix: '-16x9',
    ...DEFAULT_CHOICE_FIELDS
  }
]

export function isBuiltIn(preset: Pick<ExportPreset, 'id'>): boolean {
  return preset.id.startsWith('builtin-')
}

/** A fresh id for a preset someone saved. */
export function newPresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Bring a preset read off disk into range.
 *
 * The settings file is JSON on a user's disk and can be hand-edited, and a CRF
 * of 900 or an aspect that no longer exists must not reach ffmpeg — a bad
 * preset should export something slightly wrong, not fail at the encoder with
 * a message about an option nobody set.
 */
export function sanePreset(raw: Partial<ExportPreset>, fallback: ExportPreset): ExportPreset {
  const aspects: AspectKey[] = ['16:9', '9:16', '1:1']
  // The delivery half is sanitised by the same function the Output panel's
  // stored choice is, so a preset and the panel cannot disagree about a range.
  const choice = saneChoice(raw, fallback)

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : fallback.name,
    aspect: aspects.includes(raw.aspect as AspectKey) ? (raw.aspect as AspectKey) : fallback.aspect,
    ...choice,
    loudness:
      raw.loudness === null
        ? null
        : typeof raw.loudness === 'number' && Number.isFinite(raw.loudness)
          ? Math.max(-30, Math.min(-8, raw.loudness))
          : fallback.loudness,
    captions: typeof raw.captions === 'boolean' ? raw.captions : fallback.captions,
    // A suffix reaches a FILENAME, so it is held to the strict (Windows) set —
    // `Bride 5:30pm` is an ordinary thing for someone to type.
    suffix:
      typeof raw.suffix === 'string'
        ? raw.suffix.replace(/[<>:"|?*\\/]/g, '').replace(/[. ]+$/, '').slice(0, 24)
        : fallback.suffix
  }
}

/**
 * The output path for one preset, given the name the user chose.
 *
 * Suffixes exist so three presets of one edit do not overwrite each other —
 * which they silently would, since each export names itself after the project.
 */
export function pathForPreset(basePath: string, preset: ExportPreset): string {
  if (!preset.suffix) return basePath
  const dot = basePath.lastIndexOf('.')
  // No extension, or a dot that is part of a directory name rather than the
  // file's: append and let the caller's extension logic stand.
  const slash = Math.max(basePath.lastIndexOf('/'), basePath.lastIndexOf('\\'))
  if (dot <= slash) return `${basePath}${preset.suffix}`
  return `${basePath.slice(0, dot)}${preset.suffix}${basePath.slice(dot)}`
}
