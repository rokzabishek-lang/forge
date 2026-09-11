import type { MediaKind } from './types'
import type { Transcript } from './transcript'

/**
 * Everything on the timeline is measured in whole frames at the project frame
 * rate. Seconds are a display concern only — floating-point positions drift and
 * make cuts land a frame off, which is exactly the bug you cannot debug later.
 */
export type Frames = number

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  sampleRate: number
}

export interface CaptionSettings {
  enabled: boolean
  /** Id from CAPTION_STYLES. */
  styleId: string
  /** User edits layered over the preset; see resolveStyle. */
  overrides?: Record<string, unknown>
}

export interface MediaAsset {
  id: string
  path: string
  name: string
  kind: MediaKind
  /** Source length in project frames. Stills get a nominal length. */
  durationFrames: Frames
  width: number | null
  height: number | null
  /** Source frame rate; null for audio and stills. */
  fps: number | null
  hasVideo: boolean
  hasAudio: boolean
  size: number
}

export interface Transform {
  /** Offset from centre, in project pixels. */
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

export interface ColorAdjust {
  brightness: number
  contrast: number
  saturation: number
}

/**
 * The reframe rectangle, in SOURCE pixels. This is what auto-reframe computes and
 * what the user drags in the NLE when the crop lands on the wrong person.
 * Undefined means "use the whole frame".
 */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
export const DEFAULT_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 }

export interface Clip {
  id: string
  assetId: string
  trackId: string
  /** Position of the clip's first frame on the timeline. */
  start: Frames
  /** Length on the timeline. */
  duration: Frames
  /** Offset into the source media of the clip's first frame. */
  inPoint: Frames
  volume: number
  transform: Transform
  color: ColorAdjust
  /** Static reframe rectangle. Keyframed crop paths arrive with the NLE. */
  crop?: CropRect
  /**
   * Transition into this clip. The clip genuinely overlaps the one before it by
   * `durationFrames` — that overlap IS the transition, and the compositor draws
   * this clip over the previous one for its duration.
   */
  transitionIn?: { id: string; durationFrames: Frames }
}

export interface Track {
  id: string
  kind: 'video' | 'audio'
  name: string
  muted: boolean
  hidden: boolean
  locked: boolean
}

export interface Project {
  name: string
  settings: ProjectSettings
  assets: MediaAsset[]
  /** Index 0 renders bottom-most; later video tracks composite on top. */
  tracks: Track[]
  clips: Clip[]
  /**
   * Transcripts keyed by asset id. They live with the project so they survive
   * save/load and so director decisions can reference their segment ids without
   * re-running ASR.
   */
  transcripts: Record<string, Transcript>
  captions: CaptionSettings
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000
}

export function framesToSeconds(frames: Frames, fps: number): number {
  return frames / fps
}

export function secondsToFrames(seconds: number, fps: number): Frames {
  return Math.round(seconds * fps)
}

/** "00:01:23:07" — hours:minutes:seconds:frames. */
export function formatTimecode(frames: Frames, fps: number): string {
  const safeFps = Math.max(1, Math.round(fps))
  const total = Math.max(0, Math.floor(frames))
  const f = total % safeFps
  const totalSeconds = Math.floor(total / safeFps)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`
}

export function clipEnd(clip: Clip): Frames {
  return clip.start + clip.duration
}

export function projectDuration(project: Project): Frames {
  return project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0)
}

export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  return project.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
}

/** The clip covering `frame` on a track, if any. */
export function clipAt(project: Project, trackId: string, frame: Frames): Clip | null {
  return (
    project.clips.find(
      (c) => c.trackId === trackId && frame >= c.start && frame < clipEnd(c)
    ) ?? null
  )
}

/** Every clip covering `frame`, ordered bottom track first (render order). */
export function clipsAtFrame(project: Project, frame: Frames): Clip[] {
  const trackOrder = new Map(project.tracks.map((t, i) => [t.id, i]))
  return project.clips
    .filter((c) => frame >= c.start && frame < clipEnd(c))
    .sort((a, b) => (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0))
}

/** Source frame the clip is showing when the playhead is at `frame`. */
export function sourceFrameFor(clip: Clip, frame: Frames): Frames {
  return clip.inPoint + (frame - clip.start)
}

export function assetById(project: Project, id: string): MediaAsset | null {
  return project.assets.find((a) => a.id === id) ?? null
}

/**
 * Two clips may not occupy the same frames on one track. Returns the clips that
 * `candidate` would collide with, ignoring the clip being moved.
 */
export function overlapsOn(
  project: Project,
  trackId: string,
  start: Frames,
  duration: Frames,
  ignoreClipId?: string
): Clip[] {
  const end = start + duration
  return project.clips.filter(
    (c) =>
      c.trackId === trackId &&
      c.id !== ignoreClipId &&
      start < clipEnd(c) &&
      end > c.start
  )
}

/** First frame >= `desired` where the clip fits on the track without overlapping. */
export function findFreeSlot(
  project: Project,
  trackId: string,
  desired: Frames,
  duration: Frames,
  ignoreClipId?: string
): Frames {
  let start = Math.max(0, desired)
  // Walk past each collision; tracks hold few enough clips that this is fine.
  for (let guard = 0; guard < 10000; guard++) {
    const hits = overlapsOn(project, trackId, start, duration, ignoreClipId)
    if (hits.length === 0) return start
    start = Math.max(...hits.map(clipEnd))
  }
  return start
}

/**
 * Split a clip at an absolute timeline frame.
 * Returns the two halves, or null when the frame is not strictly inside the clip.
 */
export function splitClip(clip: Clip, frame: Frames): [Clip, Clip] | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null
  const leftDuration = frame - clip.start
  const left: Clip = { ...clip, duration: leftDuration }
  const right: Clip = {
    ...clip,
    id: `${clip.id}-b`,
    start: frame,
    duration: clip.duration - leftDuration,
    inPoint: clip.inPoint + leftDuration
  }
  return [left, right]
}

/**
 * Drag the left edge. The clip's content stays put on the timeline: moving the
 * head in also moves the source in-point, so the visible frames do not slide.
 */
export function trimStart(clip: Clip, newStart: Frames): Clip {
  const maxStart = clipEnd(clip) - 1
  const delta = Math.min(newStart, maxStart) - clip.start
  // Cannot pull the head earlier than the start of the source media.
  const limited = Math.max(delta, -clip.inPoint)
  return {
    ...clip,
    start: clip.start + limited,
    duration: clip.duration - limited,
    inPoint: clip.inPoint + limited
  }
}

/** Drag the right edge. Cannot run past the end of the source media. */
export function trimEnd(clip: Clip, newEnd: Frames, sourceDuration: Frames): Clip {
  const minEnd = clip.start + 1
  const maxEnd = clip.start + (sourceDuration - clip.inPoint)
  const end = Math.max(minEnd, Math.min(newEnd, maxEnd))
  return { ...clip, duration: end - clip.start }
}

/** Beyond this the timeline stops being readable and ffmpeg graphs get slow. */
export const MAX_TRACKS = 12

/** Next free name for a kind: V1, V2, V3... */
export function nextTrackName(tracks: Track[], kind: Track['kind']): string {
  const prefix = kind === 'video' ? 'V' : 'A'
  const used = tracks.filter((t) => t.kind === kind).length
  return `${prefix}${used + 1}`
}

/**
 * Insert a track, keeping video tracks above audio in the array.
 * Render order depends on this ordering, so it is not cosmetic.
 */
export function addTrack(project: Project, kind: Track['kind']): Project {
  if (project.tracks.length >= MAX_TRACKS) return project

  const track: Track = {
    id: `${kind === 'video' ? 'v' : 'a'}${Date.now().toString(36)}`,
    kind,
    name: nextTrackName(project.tracks, kind),
    muted: false,
    hidden: false,
    locked: false
  }

  const video = project.tracks.filter((t) => t.kind === 'video')
  const audio = project.tracks.filter((t) => t.kind === 'audio')
  return {
    ...project,
    tracks: kind === 'video' ? [...video, track, ...audio] : [...video, ...audio, track]
  }
}

/** Removing a track removes its clips; there is nowhere for them to go. */
export function removeTrack(project: Project, trackId: string): Project {
  const remaining = project.tracks.filter((t) => t.id !== trackId)
  if (remaining.length === project.tracks.length) return project
  // Never leave a project with no video track — the renderer requires one.
  if (!remaining.some((t) => t.kind === 'video')) return project
  return {
    ...project,
    tracks: remaining,
    clips: project.clips.filter((c) => c.trackId !== trackId)
  }
}

/** Longest transition that still leaves a frame of each clip un-blended. */
export function maxTransitionFrames(previous: Clip, next: Clip): Frames {
  return Math.max(0, Math.min(previous.duration - 1, next.duration - 1))
}

/**
 * Attach a transition to a clip, creating the overlap it needs.
 *
 * The clip and everything after it on the track move earlier by the transition
 * length, so the timeline shortens — which is what actually happens in an edit:
 * a dissolve consumes time from both sides rather than adding any.
 */
export function addTransition(
  project: Project,
  clipId: string,
  transitionId: string,
  durationFrames: Frames
): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return project

  const onTrack = clipsOnTrack(project, clip.trackId)
  const index = onTrack.findIndex((c) => c.id === clipId)
  const previous = index > 0 ? onTrack[index - 1] : null
  // A transition needs something to transition from.
  if (!previous) return project

  const already = clip.transitionIn?.durationFrames ?? 0
  const frames = Math.max(1, Math.min(durationFrames, maxTransitionFrames(previous, clip)))
  // Shift by the delta so changing an existing transition does not stack.
  const shift = frames - already
  if (frames === already && clip.transitionIn?.id === transitionId) return project

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.trackId !== clip.trackId) return c
      if (c.id === clipId) {
        return {
          ...c,
          start: Math.max(0, c.start - shift),
          transitionIn: { id: transitionId, durationFrames: frames }
        }
      }
      // Everything later on the track moves with it.
      return c.start > clip.start ? { ...c, start: Math.max(0, c.start - shift) } : c
    })
  }
}

/** Remove a transition and restore the time it consumed. */
export function removeTransition(project: Project, clipId: string): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip?.transitionIn) return project
  const shift = clip.transitionIn.durationFrames

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.trackId !== clip.trackId) return c
      if (c.id === clipId) {
        const { transitionIn: _removed, ...rest } = c
        return { ...rest, start: c.start + shift }
      }
      return c.start > clip.start ? { ...c, start: c.start + shift } : c
    })
  }
}

/** The clip a transition blends from, if any. */
export function clipBefore(project: Project, clip: Clip): Clip | null {
  const onTrack = clipsOnTrack(project, clip.trackId)
  const index = onTrack.findIndex((c) => c.id === clip.id)
  return index > 0 ? onTrack[index - 1] : null
}

export function emptyProject(name = 'Untitled'): Project {
  return {
    name,
    settings: { ...DEFAULT_SETTINGS },
    assets: [],
    // Two of each by default: enough to show that layering exists without
    // presenting an empty stack of tracks nobody asked for.
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false },
      { id: 'a2', kind: 'audio', name: 'A2', muted: false, hidden: false, locked: false }
    ],
    clips: [],
    transcripts: {},
    captions: { enabled: true, styleId: 'pop' }
  }
}
