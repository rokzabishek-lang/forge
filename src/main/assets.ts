import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { MediaInfo } from '@shared/types'
import type { MediaAsset } from '@shared/timeline'
import { secondsToFrames } from '@shared/timeline'

/** A still has no intrinsic length; this is how long it lands on the timeline. */
export const DEFAULT_STILL_SECONDS = 5

/**
 * Convert probe output into a timeline asset.
 *
 * Durations become project frames here and nowhere else — keeping the conversion
 * at the boundary is what stops floating-point seconds leaking into the timeline.
 */
export function toAsset(info: MediaInfo, projectFps: number): MediaAsset {
  const seconds =
    info.kind === 'image'
      ? DEFAULT_STILL_SECONDS
      : info.durationMs !== null
        ? info.durationMs / 1000
        : 0

  return {
    id: randomUUID(),
    path: info.path,
    name: info.name,
    kind: info.kind,
    durationFrames: Math.max(1, secondsToFrames(seconds, projectFps)),
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasVideo: info.kind !== 'audio' && info.width !== null,
    hasAudio: info.audioCodec !== null,
    size: info.size
  }
}

/**
 * A cheap key for a file's contents: its size and modification time.
 *
 * What the Director's measurements and looks are cached under (docs/PLAN.md
 * §4.1), the same key `stems.ts` and `transitions/maskTags.ts` use — a photo
 * replaced by a different one of the same name gets a different key, and one
 * whose project folder moved keeps its key. Null when the file cannot be read.
 */
export async function fileKey(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return `${info.size}:${Math.round(info.mtimeMs)}`
  } catch {
    return null
  }
}
