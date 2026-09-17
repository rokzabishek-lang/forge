import { spawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { EMPTY_PROGRESS, parseProgressChunk, progressFraction } from '@shared/progress'
import { FFMPEG_PATH } from './paths'

export interface RunOptions {
  /** Preset-built argv: input flags, filters, and the output path. */
  args: string[]
  /** Used to turn ffmpeg's out-time into a percentage. Null = indeterminate. */
  durationMs: number | null
  outputPath: string
  onProgress: (progress: number, speed: string | null) => void
  /**
   * When true, `args` is already a complete invocation (globals included) and only
   * the progress flags are appended. The render planner emits complete argv so that
   * a failing render can be copy-pasted into a shell verbatim.
   */
  complete?: boolean
}

export interface RunHandle {
  promise: Promise<void>
  cancel: () => void
}

/** Keep the tail of stderr — ffmpeg's actual error is always in the last few lines. */
const MAX_STDERR_LINES = 12

/**
 * Kill a child and everything it spawned.
 *
 * Exported because yt-dlp needs the same treatment: it spawns its own ffmpeg to
 * merge streams, and a plain `child.kill()` would leave that grandchild running
 * to completion on a download the user cancelled.
 */
export function killProcess(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    // SIGTERM is not a real signal on Windows and leaves ffmpeg orphaned.
    // taskkill /t also takes down any child ffmpeg spawned.
    spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
    return
  }

  /*
   * POSIX: kill the process GROUP, not the process.
   *
   * `child.kill()` signals one pid. ffmpeg has no children of its own so that
   * was enough here — but yt-dlp spawns ffmpeg to cut a section or merge two
   * streams, and that grandchild survived. Worse, it inherits yt-dlp's stdout,
   * so our pipe stayed open and the `close` event — which is where the job
   * rejects and the partial files are removed — did not fire until ffmpeg
   * finished the work nobody wanted. Measured: 3.0s to close instead of 0.13s,
   * with the grandchild still running after the parent was gone.
   *
   * Killing the group needs the child to BE a group leader, which is what
   * `detached: true` does at spawn. Callers that do not set it still get the
   * right behaviour: the negative-pid kill fails with ESRCH or EPERM and we
   * fall back to the single kill.
   */
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export function runFfmpeg(options: RunOptions): RunHandle {
  const { args, durationMs, outputPath, onProgress } = options
  let cancelled = false
  let child: ChildProcess | null = null

  const promise = new Promise<void>((resolve, reject) => {
    const globals = options.complete
      ? []
      : ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
    const argv = [...globals, ...args, '-progress', 'pipe:1', '-nostats']

    child = spawn(FFMPEG_PATH, argv, { windowsHide: true })

    let snapshot = EMPTY_PROGRESS
    const stderrLines: string[] = []

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      snapshot = parseProgressChunk(chunk, snapshot)
      onProgress(progressFraction(snapshot.outTimeUs, durationMs), snapshot.speed)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() === '') continue
        stderrLines.push(line.trim())
        if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift()
      }
    })

    child.on('error', (err) => {
      reject(new Error(`Could not start ffmpeg: ${err.message}`))
    })

    /*
     * Finish only once the truncated file is actually gone.
     *
     * This used to fire the unlink and reject in the same tick, so the job was
     * reported cancelled while a half-written video was still on disk — and
     * whoever looked first won. Rejecting from the unlink's continuation makes
     * "this job ended" mean "there is nothing broken left behind".
     */
    const discard = (error: Error): void => {
      void unlink(outputPath)
        .catch(() => undefined)
        .then(() => reject(error))
    }

    child.on('close', (code) => {
      if (cancelled) {
        // A cancelled job leaves a truncated output file behind. Remove it so the
        // user is never handed a half-written video that looks like a success.
        discard(new CancelledError())
        return
      }
      if (code === 0) {
        onProgress(1, snapshot.speed)
        resolve()
        return
      }
      const detail = stderrLines.join('\n').trim()
      discard(new Error(detail || `ffmpeg exited with code ${code}`))
    })
  })

  return {
    promise,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      if (child) killProcess(child)
    }
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}
