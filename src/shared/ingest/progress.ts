/**
 * Reading yt-dlp's progress.
 *
 * yt-dlp's default output is an animated bar redrawn with carriage returns —
 * unparseable, and it changes between releases. `--progress-template` asks for
 * a line of our own design instead, which is stable across versions and is the
 * only form worth parsing. `--newline` stops the carriage returns;
 * `--progress-delta` throttles at the source, which matters because the default
 * is several updates a second and the job queue already coalesces at 150ms.
 *
 * The parser lives in shared/ for the reason the rest of the pure logic does:
 * it can be tested against real captured output with no binary, no electron and
 * no network.
 */

/** A prefix nothing else yt-dlp prints will collide with. */
const MARK = '@forge@'

/**
 * The exact `--progress-template` argument.
 *
 * Pipe-separated because every field is a number or the literal `NA`, and none
 * of them can contain a pipe. Deliberately NOT the title or the filename, which
 * can contain anything at all.
 */
export const PROGRESS_TEMPLATE =
  `download:${MARK}%(progress.status)s|%(progress.downloaded_bytes)s|` +
  `%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|` +
  `%(progress.speed)s|%(progress.eta)s`

export type IngestStatus = 'downloading' | 'finished' | 'error'

export interface ProgressLine {
  status: IngestStatus
  downloadedBytes: number | null
  /** The real total, or the estimate when that is all yt-dlp has. */
  totalBytes: number | null
  speedBps: number | null
  etaSeconds: number | null
}

/** yt-dlp writes the literal `NA` for anything it does not know yet. */
function num(field: string): number | null {
  if (!field || field === 'NA' || field === 'None') return null
  const value = Number(field)
  return Number.isFinite(value) ? value : null
}

/**
 * Parse one line, or null if it is not one of ours.
 *
 * Returning null for everything else is load-bearing rather than defensive:
 * yt-dlp writes warnings, extractor chatter and ffmpeg's own output to the same
 * stream, and all of it has to pass through here untouched.
 */
export function parseProgressLine(line: string): ProgressLine | null {
  const at = line.indexOf(MARK)
  if (at === -1) return null

  const parts = line.slice(at + MARK.length).trim().split('|')
  if (parts.length < 6) return null

  const [status, downloaded, total, estimate, speed, eta] = parts
  if (status !== 'downloading' && status !== 'finished' && status !== 'error') return null

  return {
    status,
    downloadedBytes: num(downloaded),
    totalBytes: num(total) ?? num(estimate),
    speedBps: num(speed),
    etaSeconds: num(eta)
  }
}

export interface IngestProgress {
  /** 0..1, or null while nothing can honestly be said. */
  progress: number | null
  speedBps: number | null
  etaSeconds: number | null
  /** How many streams have finished. Video then audio, for a merged download. */
  completed: number
}

/**
 * Fold the lines into one figure for the progress bar.
 *
 * The complication is that a 1080p or 4K download is TWO downloads: YouTube
 * stores video and audio separately above 720p, so yt-dlp fetches one, then the
 * other, then merges. Each reports its own 0-to-100%, so a naive reading shows
 * the bar fill, reset, and fill again — which reads as a bug.
 *
 * Summing bytes across the streams is the honest fix, but it has a wrinkle: the
 * audio stream's size is unknown until it starts, so the moment it does, the
 * denominator grows and the true fraction drops (a 100MB video at 100% becomes
 * 100 of 103MB, or 97%). A bar that goes backwards also reads as a bug, and it
 * is the more alarming of the two. So the figure is clamped to never decrease.
 *
 * That makes the number very slightly optimistic in the middle and exactly
 * right at both ends, which is the correct direction to be wrong in.
 */
export function createIngestProgress(): {
  push: (line: string) => IngestProgress | null
  state: () => IngestProgress
} {
  let completed = 0
  let completedBytes = 0
  let highest = 0
  let last: IngestProgress = {
    progress: null,
    speedBps: null,
    etaSeconds: null,
    completed: 0
  }

  return {
    push(line: string): IngestProgress | null {
      const parsed = parseProgressLine(line)
      if (!parsed) return null

      if (parsed.status === 'finished') {
        completed += 1
        completedBytes += parsed.downloadedBytes ?? parsed.totalBytes ?? 0
        // Not 1.0: a finished stream may be the first of two, and claiming the
        // whole job is done is how a bar gets stuck at 100% for a minute.
        last = { progress: highest, speedBps: null, etaSeconds: null, completed }
        return last
      }

      if (parsed.status === 'error') {
        last = { ...last, speedBps: null, etaSeconds: null }
        return last
      }

      const done = completedBytes + (parsed.downloadedBytes ?? 0)
      const total = completedBytes + (parsed.totalBytes ?? 0)
      const fraction = total > 0 ? done / total : null

      if (fraction !== null) highest = Math.max(highest, Math.min(1, fraction))

      last = {
        progress: fraction === null ? null : highest,
        speedBps: parsed.speedBps,
        etaSeconds: parsed.etaSeconds,
        completed
      }
      return last
    },
    state: () => last
  }
}
