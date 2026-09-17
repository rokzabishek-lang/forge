import type { Clip, Project, Track } from '../timeline'
import { clipsOnTrack, framesToSeconds } from '../timeline'
import type { CaptionStyle } from './style'
import { buildAss, toAssTime } from './ass'
import type { Segment, Word } from '../transcript'

/**
 * Build one ASS file covering the whole timeline.
 *
 * Captions are burned onto the concatenated picture, so every cue has to be in
 * TIMELINE time. A transcript is in SOURCE time, so each clip contributes its
 * words shifted by (inPoint - start) and clipped to the span it actually shows.
 * Trim a clip and its captions move with it — which is the behaviour that breaks
 * first if this mapping is done anywhere else.
 */
/**
 * The track captions are built from.
 *
 * The bottom visible video track — the picture, rather than whatever is stacked
 * over it. This exists so the preview and the export cannot disagree about it,
 * and they did: the preview took the TOPMOST layer at the playhead, so putting a
 * text card on a track above made the captions vanish from the screen while they
 * still burned into the exported file. A caption that is missing only where you
 * can see it is the worst version of that bug.
 *
 * Known limit, unchanged by this: a transcript belonging to a clip on an upper
 * track is still never read.
 */
export function captionTrack(project: Project): Track | null {
  const visible = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  if (visible.length === 0) return null

  /*
   * The lowest visible track that actually has something transcribed on it.
   *
   * It used to be simply the lowest, full stop — so a clip that had been
   * transcribed and then moved up a track, which is now the ordinary result of
   * stacking overlays, silently produced no captions at all. Preferring a track
   * with transcripts fixes that without letting two tracks caption at once,
   * which would be two people talking over each other.
   */
  const transcribed = visible.find((track) =>
    project.clips.some((c) => c.trackId === track.id && project.transcripts[c.assetId])
  )
  return transcribed ?? visible[0]
}

/** The clip captions come from at one frame, matching what the export builds. */
export function captionSourceClip(project: Project, frame: number): Clip | null {
  const track = captionTrack(project)
  if (!track) return null
  return (
    clipsOnTrack(project, track.id).find(
      (c) => frame >= c.start && frame < c.start + c.duration
    ) ?? null
  )
}

export function buildTimelineCaptions(
  project: Project,
  style: CaptionStyle,
  canvas: { width: number; height: number }
): string | null {
  const fps = project.settings.fps
  const videoTrack = captionTrack(project)
  if (!videoTrack) return null

  const blocks: string[] = []
  let header: string | null = null

  for (const clip of clipsOnTrack(project, videoTrack.id)) {
    const transcript = project.transcripts[clip.assetId]
    const clipDurationMs = framesToSeconds(clip.duration, fps) * 1000

    if (transcript) {
      const inPointMs = framesToSeconds(clip.inPoint, fps) * 1000
      /*
       * Where the clip actually SITS, not where it would sit if nothing moved.
       *
       * This used to accumulate durations into a running cursor, which is the
       * same number as `clip.start` only while every clip is packed against its
       * neighbour from zero. Leave a gap, or drag one clip later, and every
       * caption after it drifts by the size of the gap — timed against a
       * timeline that no longer exists.
       */
      const offsetMs = inPointMs - framesToSeconds(clip.start, fps) * 1000

      const ass = buildAss(transcript.segments as Segment[], transcript.words as Word[], {
        width: canvas.width,
        height: canvas.height,
        style,
        offsetMs,
        rangeMs: { startMs: inPointMs, endMs: inPointMs + clipDurationMs }
      })

      const lines = ass.split('\n')
      const eventsAt = lines.findIndex((l) => l.startsWith('Format: Layer'))
      if (header === null) header = lines.slice(0, eventsAt + 1).join('\n')
      blocks.push(...lines.slice(eventsAt + 1).filter((l) => l.startsWith('Dialogue:')))
    }
  }

  if (header === null || blocks.length === 0) return null
  return `${header}\n${blocks.join('\n')}\n`
}

/**
 * Escape a path for use inside an ffmpeg filter argument.
 *
 * This is a notorious footgun: the filter graph parser treats ':' as an argument
 * separator and '\' as an escape, so a Windows path like C:\a\b.ass is parsed as
 * three arguments unless both are escaped. Backslashes are normalised to forward
 * slashes first, which ffmpeg accepts on Windows and which removes one whole
 * layer of escaping.
 */
export function escapeFilterPath(path: string): string {
  const normalised = path.replace(/\\/g, '/')
  return normalised
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
}

/** Total timeline length as an ASS timestamp, for logs and diagnostics. */
export function timelineEndTimecode(project: Project): string {
  const fps = project.settings.fps
  const last = project.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0)
  return toAssTime(framesToSeconds(last, fps) * 1000)
}
