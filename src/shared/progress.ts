export interface ProgressSnapshot {
  /** Output timestamp reached, in microseconds. */
  outTimeUs: number | null
  speed: string | null
  frame: number | null
  /** True once ffmpeg reports progress=end. */
  done: boolean
}

export const EMPTY_PROGRESS: ProgressSnapshot = {
  outTimeUs: null,
  speed: null,
  frame: null,
  done: false
}

/**
 * Parse a chunk of `ffmpeg -progress pipe:1` output.
 *
 * ffmpeg emits repeating blocks of `key=value` lines terminated by
 * `progress=continue` or `progress=end`. We take the last value seen for each
 * key in the chunk and merge it onto the previous snapshot.
 *
 * Note: `out_time_ms` is a long-standing ffmpeg misnomer — it is reported in
 * MICROseconds, same as `out_time_us`. Treating it as milliseconds makes
 * progress read 1000x too high.
 */
export function parseProgressChunk(chunk: string, prev: ProgressSnapshot): ProgressSnapshot {
  const next: ProgressSnapshot = { ...prev }

  for (const line of chunk.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()

    switch (key) {
      case 'out_time_us':
      case 'out_time_ms': {
        const n = Number(value)
        if (Number.isFinite(n) && n >= 0) next.outTimeUs = n
        break
      }
      case 'frame': {
        const n = Number(value)
        if (Number.isFinite(n)) next.frame = n
        break
      }
      case 'speed': {
        // "N/A" until the first frames are through.
        next.speed = value === 'N/A' || value === '' ? null : value
        break
      }
      case 'progress': {
        if (value === 'end') next.done = true
        break
      }
    }
  }

  return next
}

/** Clamp a raw out-time against a known duration into a 0..1 fraction. */
export function progressFraction(outTimeUs: number | null, durationMs: number | null): number {
  if (outTimeUs === null || durationMs === null || durationMs <= 0) return 0
  const fraction = outTimeUs / 1000 / durationMs
  if (!Number.isFinite(fraction)) return 0
  return Math.min(1, Math.max(0, fraction))
}
