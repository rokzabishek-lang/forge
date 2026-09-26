import type { Clip, MediaAsset } from '../timeline'
import type { Problem } from './conforms'
import type { SoundEvent } from './recipes'
import type { SoundEventOut } from './rhythm'
import type { SoundFile, SoundPack, SoundRole } from './soundRoles'
import { SOUND_RULE } from './apply'
import {
  HIT_TAIL_FADE_SECONDS,
  HIT_TAIL_MAX_SECONDS,
  PEAK_TAIL_FRAMES,
  RISE_FADE_IN_SHARE,
  soundGain
} from '../render/soundLevels'

/**
 * Sound design: the events the rhythm engine fired, as clips (docs/PLAN.md §6.1).
 *
 * Firing is deterministic — the recipe names the events and the engine put
 * each on a frame — and this realises them. Each sound's measured PEAK lands
 * on the event's frame (a riser ends on the cut at its peak, a braam's hit
 * lands 0.555 s into its file), never the file's start or end. Levels are the
 * one table in render/soundLevels.ts, normalised by the file's own peak. The
 * silence is not a clip: it is the music's envelope, which apply2 draws on
 * the music from what is returned here. Pure: the lanes come from a callback,
 * so the caller owns its tracks.
 */

export const SOUND_LANE_NAME = 'Sound design'

/** Which roles may stand in for an event, best first. A hit with no hit in the library is a sub-drop — the low layer the plan named. */
const ROLES_FOR: Record<Exclude<SoundEvent, 'silence'>, SoundRole[]> = {
  riser: ['riser', 'swell'],
  swell: ['swell', 'riser'],
  hit: ['hit', 'braam', 'sub'],
  braam: ['braam', 'hit', 'sub'],
  sub: ['sub'],
  whoosh: ['whoosh']
}

export interface PlaceSoundsOptions {
  fps: number
  /** The music's fader; every level is relative to it. */
  musicVolume: number
  /** The ad's one dial (coherence.ts). */
  intensity: number
  /** How long a transition runs, so a whoosh can be centred on it. */
  transitionFrames: number
  newId: (prefix: string) => string
  /** The project's assets, so a sound already in the pool is reused rather than added again. */
  assets: MediaAsset[]
  /** A lane free over the span — counting the sounds placed so far in this call, which are not on the project yet — or null when there is none. */
  laneFor: (start: number, duration: number, placed: Clip[]) => string | null
}

export interface PlacedSounds {
  clips: Clip[]
  /** Assets the project does not have yet, one per sound file used. */
  assets: MediaAsset[]
  /** The music's silences: gone by `at`, back at `until` (timeline frames); `until` null when it does not return. */
  silences: { at: number; until: number | null }[]
  problems: Problem[]
}

/**
 * The file for an event: the best role the pack has for it, and within that
 * role the longest first (a riser wants seconds to build), varying by the
 * event's index so two hits in one ad are not the same sound twice.
 */
export function pickSound(event: Exclude<SoundEvent, 'silence'>, pack: SoundPack, index: number): SoundFile | null {
  for (const role of ROLES_FOR[event]) {
    const files = pack.filter((f) => f.role === role).sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))
    if (files.length > 0) return files[index % files.length]
  }
  return null
}

export function placeSounds(events: SoundEventOut[], pack: SoundPack, options: PlaceSoundsOptions): PlacedSounds {
  const { fps, newId } = options
  const clips: Clip[] = []
  const assets: MediaAsset[] = []
  const silences: PlacedSounds['silences'] = []
  const problems: Problem[] = []
  const indexOf = new Map<string, number>()
  const assetFor = new Map<string, string>(options.assets.filter((a) => a.kind === 'audio').map((a) => [a.path, a.id]))

  const fired = events.filter((e) => e.event !== 'silence')
  if (fired.length > 0 && pack.length === 0) {
    problems.push({ path: '$.sounds', message: `no sound library is installed — the ad has no sound design (${fired.length} sound${fired.length === 1 ? '' : 's'} not placed)` })
  }

  for (const e of events) {
    if (e.event === 'silence') {
      silences.push({ at: e.frame, until: e.untilFrame ?? null })
      continue
    }
    if (pack.length === 0) continue
    const event = e.event
    const index = indexOf.get(event) ?? 0
    indexOf.set(event, index + 1)
    const file = pickSound(event, pack, index)
    if (!file) {
      problems.push({ path: '$.sounds', message: `no ${event} in the sound library — not placed` })
      continue
    }

    const fileFrames = Math.max(1, Math.round(file.seconds * fps))
    const peakFrames = Math.min(fileFrames - 1, Math.round(file.peakSeconds * fps))
    // A whoosh is centred on the transition, whose blend runs over the incoming shot's first frames.
    const target = event === 'whoosh' ? e.frame + Math.round(options.transitionFrames / 2) : e.frame
    // The file starts so that its peak lands on the target; before the timeline's start, it starts part-way in.
    let start = target - peakFrames
    let inPoint = 0
    if (start < 0) {
      inPoint = -start
      start = 0
    }
    if (inPoint >= fileFrames - 1) {
      problems.push({ path: '$.sounds', message: `the ${event} at ${(e.frame / fps).toFixed(2)} s has no room before it — not placed` })
      continue
    }
    const toPeak = peakFrames - inPoint

    let duration: number
    let fadeIn: number | undefined
    let fadeOut: number | undefined
    if (event === 'riser' || event === 'swell') {
      // Up to the peak and a few frames past it; in over its first fifth.
      duration = Math.min(fileFrames - inPoint, toPeak + PEAK_TAIL_FRAMES)
      fadeIn = Math.round(RISE_FADE_IN_SHARE * toPeak)
      fadeOut = Math.min(PEAK_TAIL_FRAMES, Math.max(0, duration - 1))
    } else if (event === 'whoosh') {
      duration = fileFrames - inPoint
    } else {
      // A hit keeps its tail, but not a ten-second one under the end card.
      const most = toPeak + Math.round(HIT_TAIL_MAX_SECONDS * fps)
      duration = Math.min(fileFrames - inPoint, most)
      if (duration < fileFrames - inPoint) fadeOut = Math.min(Math.round(HIT_TAIL_FADE_SECONDS * fps), Math.max(0, duration - 1))
    }
    duration = Math.max(1, duration)

    const lane = options.laneFor(start, duration, clips)
    if (!lane) {
      problems.push({ path: '$.sounds', message: `no lane for the ${event} at ${(e.frame / fps).toFixed(2)} s — not placed` })
      continue
    }

    let assetId = assetFor.get(file.file)
    if (!assetId) {
      assetId = newId('dir-sfx')
      assetFor.set(file.file, assetId)
      assets.push({
        id: assetId,
        path: file.file,
        name: file.name,
        kind: 'audio',
        durationFrames: fileFrames,
        width: null,
        height: null,
        fps: null,
        hasVideo: false,
        hasAudio: true,
        // A library file, not a drawn card: any positive size says so (the pool never shows a sound's bytes).
        size: 1
      })
    }

    clips.push({
      id: newId('dir-sound'),
      assetId,
      trackId: lane,
      start,
      duration,
      inPoint,
      volume: soundGain(event, file.peakDb, options.musicVolume, options.intensity),
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      ...(fadeIn && fadeIn > 0 ? { fadeIn } : {}),
      ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}),
      generatedBy: { rule: SOUND_RULE, reason: `${event} at ${(e.frame / fps).toFixed(2)} s · ${file.name}${file.credit ? ` · ${file.credit}` : ''}` }
    })
  }

  return { clips, assets, silences, problems }
}
