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

export interface ExportPreset {
  id: string
  name: string
  /** The canvas it renders to. */
  aspect: AspectKey
  /**
   * x264's quality knob — lower is better and bigger. 20 is the app's normal
   * export, 26 is its draft, and the range either side is what people reach
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
    suffix: '-9x16'
  },
  {
    id: 'builtin-feed',
    name: 'Feed square (1:1)',
    aspect: '1:1',
    crf: 20,
    preset: 'medium',
    loudness: -14,
    captions: true,
    suffix: '-1x1'
  },
  {
    id: 'builtin-wide',
    name: 'YouTube (16:9)',
    aspect: '16:9',
    crf: 19,
    preset: 'slow',
    loudness: -14,
    captions: false,
    suffix: '-16x9'
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
  const speeds: ExportPreset['preset'][] = ['veryfast', 'faster', 'fast', 'medium', 'slow']
  const aspects: AspectKey[] = ['16:9', '9:16', '1:1']
  const crf = typeof raw.crf === 'number' && Number.isFinite(raw.crf) ? Math.round(raw.crf) : fallback.crf

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : fallback.name,
    aspect: aspects.includes(raw.aspect as AspectKey) ? (raw.aspect as AspectKey) : fallback.aspect,
    crf: Math.max(CRF_MIN, Math.min(CRF_MAX, crf)),
    preset: speeds.includes(raw.preset as ExportPreset['preset'])
      ? (raw.preset as ExportPreset['preset'])
      : fallback.preset,
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
