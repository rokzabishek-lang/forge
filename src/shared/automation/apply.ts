import type { Clip, Project, Track } from '../timeline'
import { clipsOnTrack, framesToSeconds, secondsToFrames } from '../timeline'
import { findTriggerHits, type PropTrigger, type TriggerOptions } from './keywords'

/**
 * Turn rule output into ordinary timeline clips.
 *
 * Everything an automation rule produces is a normal clip the user can drag,
 * trim or delete — nothing is hidden or held in a private representation. That
 * is what stops automation being a black box. See docs/AUTOMATION.md §1.
 */

export const PROP_RULE = 'props.keyword'

export interface PlannedProp {
  /** Asset path relative to the assets root. */
  file: string
  name: string
  /** Timeline position, in frames. */
  startFrame: number
  durationFrames: number
  reason: string
}

/** Remove a rule's previous output, so re-running replaces rather than stacks. */
export function clearGenerated(project: Project, rule: string): Project {
  return { ...project, clips: project.clips.filter((c) => c.generatedBy?.rule !== rule) }
}

export function generatedCount(project: Project, rule: string): number {
  return project.clips.filter((c) => c.generatedBy?.rule === rule).length
}

/**
 * Where a prop should appear, in timeline frames.
 *
 * Hits are found in SOURCE time against an asset's transcript, so each one has
 * to be mapped through the clip that shows that source — a hit at 10s of source
 * is not at 10s of timeline unless the clip is untrimmed and starts at zero.
 */
export function planPropClips(
  project: Project,
  triggers: PropTrigger[],
  options: TriggerOptions,
  durationFrames: number
): PlannedProp[] {
  const fps = project.settings.fps
  const planned: PlannedProp[] = []

  const videoTracks = project.tracks.filter((t) => t.kind === 'video')
  if (videoTracks.length === 0) return planned

  for (const track of videoTracks) {
    for (const clip of clipsOnTrack(project, track.id)) {
      const transcript = project.transcripts[clip.assetId]
      if (!transcript) continue

      const clipStartMs = framesToSeconds(clip.inPoint, fps) * 1000
      const clipEndMs = clipStartMs + framesToSeconds(clip.duration, fps) * 1000

      for (const hit of findTriggerHits(transcript, triggers, options)) {
        if (hit.startMs < clipStartMs || hit.startMs >= clipEndMs) continue

        const intoClipMs = hit.startMs - clipStartMs
        const startFrame = clip.start + secondsToFrames(intoClipMs / 1000, fps)

        planned.push({
          file: hit.file,
          name: hit.name,
          startFrame,
          durationFrames,
          reason: `"${hit.matchedWord}" matched ${hit.tag}`
        })
      }
    }
  }

  return planned.sort((a, b) => a.startFrame - b.startFrame)
}

/**
 * The track automation writes onto.
 *
 * The topmost video track, so generated overlays land above the picture rather
 * than underneath it — and never the bottom track, which holds the footage.
 */
export function overlayTrackFor(project: Project): Track | null {
  const videoTracks = project.tracks.filter((t) => t.kind === 'video' && !t.locked)
  if (videoTracks.length === 0) return null
  return videoTracks[videoTracks.length - 1]
}

export function makeGeneratedClip(options: {
  id: string
  assetId: string
  trackId: string
  startFrame: number
  durationFrames: number
  rule: string
  reason: string
}): Clip {
  return {
    id: options.id,
    assetId: options.assetId,
    trackId: options.trackId,
    start: Math.max(0, options.startFrame),
    duration: options.durationFrames,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    generatedBy: { rule: options.rule, reason: options.reason }
  }
}
