/**
 * The shape of an export beyond its codec: how big, how much of the edit, and
 * how long is left.
 *
 * Pure, so the Output panel, the render plan and the tests all ask the same
 * questions of the same functions.
 */

import { ASPECTS, type AspectKey } from './aspect'
import type { Container } from './encode'

/* ------------------------------------------------------------ resolution */

export type Resolution = '720p' | '1080p' | '4k'

/**
 * Sizes as a MULTIPLIER on the aspect's own canvas, not as more aspects.
 *
 * `ASPECTS` is matched by ratio (`aspectOf`), so a 3840×2160 entry would be
 * indistinguishable from 1920×1080 and one of them would never be found. And a
 * project is cut for a SHAPE; the size is a delivery decision made at export,
 * which is where Premiere and Resolve both put it.
 */
export const RESOLUTIONS: { id: Resolution; label: string; scale: number; hint: string }[] = [
  { id: '720p', label: '720p', scale: 2 / 3, hint: 'Quicker to make, about half the pixels — fine for a phone screen or checking the edit' },
  { id: '1080p', label: '1080p', scale: 1, hint: 'What every platform plays' },
  { id: '4k', label: '4K', scale: 2, hint: 'Four times the pixels, and about four times the render' }
]

export function isResolution(value: unknown): value is Resolution {
  return RESOLUTIONS.some((r) => r.id === value)
}

/** Even, because 4:2:0 chroma is sampled in pairs and an odd size is refused. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/**
 * The canvas an export renders at: the aspect's own canvas, times the size.
 *
 * The render is pixel-bound (measured: 29.5 s at 1080×1920 against 8.0 s at
 * 540×960), so 720p is the quick one — there is no separate half-size draft.
 */
export function exportCanvas(aspect: AspectKey, resolution: Resolution): { width: number; height: number } {
  const base = ASPECTS[aspect] ?? ASPECTS['16:9']
  const scale = RESOLUTIONS.find((r) => r.id === resolution)?.scale ?? 1
  return { width: even(base.width * scale), height: even(base.height * scale) }
}

/* ----------------------------------------------------------------- range */

/** Frames `[start, end)` — the out point is a boundary, as on the timeline. */
export interface FrameRange {
  start: number
  end: number
}

/**
 * The stretch to export from the in and out points, or null for all of it.
 *
 * Null when neither is set, and when the marks cover the whole edit anyway —
 * a range that changes nothing should not add a trim to the graph. Clamped
 * into the edit, because an out point left past the end after a delete is an
 * ordinary thing to have. An empty range is `'empty'` rather than null, so the
 * caller can refuse it: exporting the whole edit when someone marked nothing
 * would be a surprise of ten minutes.
 */
export function exportRange(
  rangeIn: number | null,
  rangeOut: number | null,
  total: number
): FrameRange | null | 'empty' {
  if (rangeIn === null && rangeOut === null) return null
  const length = Math.max(0, Math.round(total))
  const clamp = (n: number): number => Math.max(0, Math.min(length, Math.round(n)))
  const start = clamp(rangeIn ?? 0)
  const end = clamp(rangeOut ?? length)
  if (end - start < 1) return 'empty'
  if (start === 0 && end === length) return null
  return { start, end }
}

/* ------------------------------------------------------------ the file */

/**
 * A path with the container's extension, whatever it was chosen with.
 *
 * The save dialog offers both, and someone switching to ProRes after picking a
 * name ending `.mp4` should get a `.mov`, not a QuickTime file wearing an MP4
 * name. The render also names the muxer outright (`-f`), so a wrong extension
 * can never choose the container; this keeps the NAME honest too.
 */
export function withContainerExtension(path: string, container: Container): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  const stem = dot > slash && /^\.(mp4|mov|m4v)$/i.test(path.slice(dot)) ? path.slice(0, dot) : path
  return `${stem}.${container}`
}

/* ----------------------------------------------------------- time left */

/**
 * Time left, from how far along the job is and how long it has taken.
 *
 * Null until the number means something: the first seconds of an export are
 * spent opening inputs and building the graph, so an estimate from them swings
 * wildly — Premiere also waits before it shows one.
 */
export function timeRemainingMs(progress: number, startedAt: number | null, now: number): number | null {
  if (startedAt === null || !Number.isFinite(progress)) return null
  if (progress < 0.02 || progress >= 1) return null
  const elapsed = now - startedAt
  if (!(elapsed >= 3000)) return null
  return Math.max(0, (elapsed * (1 - progress)) / progress)
}

/** "about 4 min left", "40 s left" — rounded the way anyone waiting reads it. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${Math.max(5, Math.ceil(seconds / 5) * 5)} s left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  return `about ${hours} h ${minutes % 60} min left`
}
