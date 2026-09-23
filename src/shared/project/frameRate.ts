/**
 * Changing a project's frame rate, with everything already on the timeline.
 *
 * Frames are the unit of the whole model, so a rate change is arithmetic — every
 * frame-valued field times new/old — but only if EVERY such field is found. One
 * missed and something drifts silently: a fade that ends early, a keyframe that
 * lands on the wrong beat, a clip reading past the end of its file. The fields
 * were inventoried from the model before this was written; they are the ones
 * below, and nothing else in a project counts in frames (transcripts are in
 * milliseconds, motion in seconds and fractions, an asset's own `fps` describes
 * the file, not the timeline).
 *
 * **Boundaries, not durations.** A clip's start and END are converted, and its
 * length is the difference, so two clips that touched still touch: rounding
 * each length on its own would open one-frame gaps between shots, or overlap
 * them, depending on where the fractions fell.
 *
 * Pictures baked frame by frame — animated captions, paper runs, the photo ring
 * — are not converted here; they are redrawn at the new rate afterwards.
 */

import type { Clip, MediaAsset, Project } from '../timeline'
import { clipSpeed, maxDurationAtSpeed } from '../render/speed'

/** The rates offered, film to smooth. 25 and 50 are PAL's — Europe, India, most of the world. */
export const FRAME_RATES = [24, 25, 30, 50, 60] as const

export function isFrameRate(value: unknown): value is (typeof FRAME_RATES)[number] {
  return FRAME_RATES.includes(value as (typeof FRAME_RATES)[number])
}

/** One frame count at the old rate, as the nearest frame at the new one. */
export function convertFrame(frames: number, from: number, to: number): number {
  return Math.round((frames * to) / from)
}

/**
 * The project at a new frame rate. The same project, unchanged, when the rate
 * is the one it already has or is not a real rate.
 */
export function convertFrameRate(project: Project, fps: number): Project {
  const from = project.settings.fps
  if (!(fps > 0) || !Number.isFinite(fps) || fps === from || !(from > 0)) return project

  const at = (frames: number): number => convertFrame(frames, from, fps)
  /** A length that has to stay at least `min` frames. */
  const len = (frames: number, min: number): number => Math.max(min, at(frames))

  const assets: MediaAsset[] = project.assets.map((a) => ({ ...a, durationFrames: len(a.durationFrames, 1) }))
  const assetById = new Map(assets.map((a) => [a.id, a]))

  const clips: Clip[] = project.clips.map((clip) => {
    const start = at(clip.start)
    const inPoint = Math.max(0, at(clip.inPoint))
    let duration = Math.max(1, at(clip.start + clip.duration) - start)
    /*
     * Never past the end of the file. Rounding the in-point up and the length
     * up together can ask a clip near the end of its source for one frame the
     * file does not have — and at speed, a few.
     */
    duration = Math.min(duration, maxDurationAtSpeed({ inPoint }, assetById.get(clip.assetId), clipSpeed(clip)))

    const next: Clip = { ...clip, start, duration, inPoint }
    if (clip.fadeIn !== undefined) next.fadeIn = len(clip.fadeIn, 0)
    if (clip.fadeOut !== undefined) next.fadeOut = len(clip.fadeOut, 0)
    if (clip.transitionIn) {
      next.transitionIn = { ...clip.transitionIn, durationFrames: len(clip.transitionIn.durationFrames, 1) }
    }
    if (clip.directorTrim) {
      next.directorTrim = {
        ...clip.directorTrim,
        duration: len(clip.directorTrim.duration, 1),
        ...(clip.directorTrim.fadeOut !== undefined ? { fadeOut: len(clip.directorTrim.fadeOut, 0) } : {})
      }
    }
    // Relative to the clip's own first frame — offsets, scaled like any other.
    if (clip.keyframes) {
      next.keyframes = Object.fromEntries(
        Object.entries(clip.keyframes).map(([property, keys]) => [
          property,
          keys?.map((k) => ({ ...k, frame: at(k.frame) }))
        ])
      ) as Clip['keyframes']
    }
    if (clip.path) next.path = clip.path.map((p) => ({ ...p, frame: at(p.frame) }))
    if (clip.paper) next.paper = { ...clip.paper, holdFrames: len(clip.paper.holdFrames, 1) }
    return next
  })

  return { ...project, settings: { ...project.settings, fps }, assets, clips }
}
