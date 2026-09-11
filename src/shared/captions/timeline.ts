import type { Project } from '../timeline'
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
export function buildTimelineCaptions(
  project: Project,
  style: CaptionStyle,
  canvas: { width: number; height: number }
): string | null {
  const fps = project.settings.fps
  const videoTrack = project.tracks.find((t) => t.kind === 'video' && !t.hidden)
  if (!videoTrack) return null

  const blocks: string[] = []
  let header: string | null = null
  /** Where this clip begins on the timeline, once earlier clips are laid down. */
  let timelineCursorMs = 0

  for (const clip of clipsOnTrack(project, videoTrack.id)) {
    const transcript = project.transcripts[clip.assetId]
    const clipDurationMs = framesToSeconds(clip.duration, fps) * 1000

    if (transcript) {
      const inPointMs = framesToSeconds(clip.inPoint, fps) * 1000
      // source -> timeline: subtract where the clip starts reading, add where it lands.
      const offsetMs = inPointMs - timelineCursorMs

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

    timelineCursorMs += clipDurationMs
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
