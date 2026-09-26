import type { AssetCatalog } from '../assets/catalog'
import { entriesOfKind } from '../assets/catalog'
import { assetPath } from '../assetPath'

/**
 * What each sound in the library IS to the Director (docs/PLAN.md §6.2).
 *
 * The catalogue's entries carry a name and a length and nothing else, so this
 * table, keyed by file name, says which of them are a riser, a swell, a hit, a
 * braam, a whoosh, a sub-drop or a tick — and, for each, where its PEAK is.
 * Measured with `scripts/measure-sfx.mjs` on the bundled ffmpeg (2026-09-26), through
 * the render's own stereo chain — a mono file plays 3 dB down on that bus:
 * a riser's loudest moment is not its last frame — the long one peaks half a
 * second before it ends — and a braam's hit is 0.555 s into its file. The
 * Director lines the peak up with the event frame (sound.ts), never the file's
 * start or end. `tests/integration/soundRoles.int.test.ts` measures every file
 * again where the library is present, so a replaced file cannot keep a stale
 * peak. The library's meme and UI sounds are not here and are not the
 * Director's.
 */

export type SoundRole = 'riser' | 'swell' | 'hit' | 'braam' | 'whoosh' | 'sub' | 'tick'

export interface SoundRoleEntry {
  role: SoundRole
  seconds: number
  /** Where the loudest 10 ms sits, from the file's start. */
  peakSeconds: number
  /** How loud that is, dBFS (RMS over the window) — the level each placement is normalised against. */
  peakDb: number
  /** A credit the licence requires, shown wherever the sound is listed. */
  credit?: string
}

export const SOUND_ROLES: Record<string, SoundRoleEntry> = {
  /* The library's own (assets/sfxx) — sub-drops peak in their first 10 ms, whooshes mid-file. */
  '808_sub_boom.wav': { role: 'sub', seconds: 0.95, peakSeconds: 0.005, peakDb: -4.2 },
  'bass_drop_sub.wav': { role: 'sub', seconds: 1.5, peakSeconds: 0.01, peakDb: -6.1 },
  'cinematic_boom.wav': { role: 'sub', seconds: 1.8, peakSeconds: 0.02, peakDb: -7.4 },
  'sub_bass_impact.wav': { role: 'sub', seconds: 0.85, peakSeconds: 0.005, peakDb: -6.5 },
  'sub_impact.wav': { role: 'sub', seconds: 0.85, peakSeconds: 0.005, peakDb: -2.5 },
  'swoosh_heavy.wav': { role: 'whoosh', seconds: 0.65, peakSeconds: 0.34, peakDb: -10.1 },
  'whoosh_fast.wav': { role: 'whoosh', seconds: 0.35, peakSeconds: 0.18, peakDb: -11.3 },
  'sword_swish.wav': { role: 'whoosh', seconds: 0.3, peakSeconds: 0.15, peakDb: -10.8 },
  'fast_whoosh.wav': { role: 'whoosh', seconds: 0.26, peakSeconds: 0.13, peakDb: -8.8 },
  'clock_tick.wav': { role: 'tick', seconds: 0.08, peakSeconds: 0.005, peakDb: -10.3 },
  'heartbeat_pulse.wav': { role: 'tick', seconds: 0.6, peakSeconds: 0.255, peakDb: -8.3 },
  // A true riser, but 1.2 s: the recipes want 2–4 s, so it is picked only when the long ones are missing.
  'riser_tension.wav': { role: 'riser', seconds: 1.2, peakSeconds: 1.195, peakDb: -8.6 },
  // A swell into a boom, not a riser: its hit is 0.6 s in — a short braam.
  'riser_climax.wav': { role: 'hit', seconds: 1.1, peakSeconds: 0.605, peakDb: -4.5 },

  /* The gaps, from Freesound (assets/sfxx/cinematic, CREDITS.md there) — CC0 unless a credit is given. */
  'syntheffects-riser-long-3.75s.mp3': { role: 'riser', seconds: 3.75, peakSeconds: 3.235, peakDb: -16.3 },
  'syntheffects-riser-short-3s.mp3': { role: 'riser', seconds: 3.047, peakSeconds: 2.78, peakDb: -19.6 },
  'beacon-cinematic-riser-subtle-3s.mp3': { role: 'riser', seconds: 3.0, peakSeconds: 2.285, peakDb: -8.7 },
  'rizzard-riser-2s.mp3': { role: 'riser', seconds: 2.0, peakSeconds: 1.98, peakDb: -9.7 },
  'fester-guitar-swell-3s.mp3': { role: 'swell', seconds: 3.063, peakSeconds: 2.98, peakDb: -19.9 },
  'flyfishing-violin-swell-5.9s.mp3': {
    role: 'swell', seconds: 5.883, peakSeconds: 3.945, peakDb: -16.2,
    credit: '"Violin single note swell" by TheFlyFishingFilmmaker, freesound.org, CC BY 4.0'
  },
  'subd-guitar-swell-14s.mp3': { role: 'swell', seconds: 14.0, peakSeconds: 1.62, peakDb: -13.4 },
  'unfa-braam-10s.mp3': { role: 'braam', seconds: 10.0, peakSeconds: 0.555, peakDb: -5.3 },
  // A 2.5 s rise into a slam: placed by the slam, the rise comes free.
  'deep-riser-slam-boom-8s.mp3': { role: 'braam', seconds: 7.984, peakSeconds: 2.875, peakDb: -3.2 }
}

/** One sound the Director may place: the table's entry with the file it is in. */
export interface SoundFile extends SoundRoleEntry {
  /** The catalogue entry's id. */
  id: string
  /** The file's name, for the pool. */
  name: string
  /** Where the file is, absolute and native — what a clip's asset points at. */
  file: string
}

export type SoundPack = SoundFile[]

const baseNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * The sounds the Director can fire, from the library as installed: every
 * catalogue sound the table knows, with its path made absolute from the
 * library's root. Empty when the library is not installed — the ad then has
 * no sound design, with one note (sound.ts).
 */
export function soundPackFor(catalog: AssetCatalog | null, root: string): SoundPack {
  if (!catalog || !root) return []
  return entriesOfKind(catalog, 'sfx')
    .flatMap((entry) => {
      const known = SOUND_ROLES[baseNameOf(entry.file)]
      return known ? [{ ...known, id: entry.id, name: baseNameOf(entry.file), file: assetPath(root, entry.file) }] : []
    })
    .sort((a, b) => a.file.localeCompare(b.file))
}
