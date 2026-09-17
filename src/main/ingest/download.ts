import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { FFMPEG_PATH } from '../ffmpeg/paths'
import { CancelledError, killProcess } from '../ffmpeg/run'
import {
  buildYtDlpArgs,
  humanError,
  outputStem,
  readMarkedLine,
  type IngestRequest
} from '@shared/ingest/args'
import { parseLink } from '@shared/ingest/url'
import { createIngestProgress, formatSpeed } from '@shared/ingest/progress'
import type { Range } from '@shared/ingest/section'
import { ALL_EXTENSIONS } from '@shared/media'

/**
 * Running one download.
 *
 * Shaped like `runFfmpeg` on purpose — a promise and a cancel — so it drops
 * into the same `JobQueue` and gets the same progress bar, speed readout and
 * cancel button the exports already have. Nothing in the renderer has to learn
 * that a job can be a download.
 *
 * Three things this has to get right that a naive spawn would not:
 *
 *   The kill takes the tree. yt-dlp spawns its own ffmpeg to merge the video
 *   and audio streams YouTube serves separately above 720p. `child.kill()`
 *   leaves that grandchild running to completion on a download nobody wants.
 *
 *   Cancelled means clean. yt-dlp leaves `.part`, `.ytdl` and per-stream
 *   `.f137.mp4` fragments behind. The promise does not settle until they are
 *   gone — the same rule run.ts arrived at the hard way, when a job read as
 *   cancelled while a half-written file was still on disk.
 *
 *   The filename is never guessed. The extension depends on which format
 *   branch won, so yt-dlp is asked to print the final path after every
 *   postprocessor has run, and that is the file that gets probed.
 */

/** How to invoke yt-dlp. Tests substitute a script that speaks the same lines. */
export interface IngestTool {
  command: string
  prefixArgs?: string[]
}

export interface IngestOutcome {
  path: string
  /** The video's title, for the asset's display name. Null if not learned. */
  title: string | null
  /** True when an earlier download of the same thing was reused. */
  cached: boolean
  /** True when the fast range path was taken and the ends want trimming. */
  approximateRange: boolean
  requestedRange: Range | null
}

export interface IngestHandle {
  promise: Promise<IngestOutcome>
  cancel: () => void
}

/** The tail of stderr — yt-dlp's real error is always in the last few lines. */
const MAX_STDERR_LINES = 12

export function downloadsDir(): string {
  return join(app.getPath('userData'), 'downloads')
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A finished file for this stem, if one exists.
 *
 * Matches `<stem>.<ext>` exactly — one extension segment, one of ours. A
 * `.part`, a `.ytdl` sidecar or an `.f137.mp4` fragment has two segments and
 * does not match, so a half-download is never handed back as a result.
 */
export async function findCached(destDir: string, stem: string): Promise<string | null> {
  const pattern = new RegExp(`^${escapeRegex(stem)}\\.([A-Za-z0-9]+)$`)
  let entries: string[]
  try {
    entries = await readdir(destDir)
  } catch {
    return null
  }
  for (const name of entries) {
    const match = pattern.exec(name)
    if (match && ALL_EXTENSIONS.includes(match[1].toLowerCase())) {
      const full = join(destDir, name)
      try {
        if ((await stat(full)).size > 0) return full
      } catch {
        // Raced with a removal; keep looking.
      }
    }
  }
  return null
}

/**
 * Everything a download of this stem could have left behind.
 *
 * Precise rather than a prefix match: `abc.video-1080p.` is a prefix of
 * `abc.video-1080p.r60000-90000.mp4`, which is a DIFFERENT finished download of
 * the same video, and cancelling one must not delete the other. The ranged
 * segment contains a hyphen, so `[A-Za-z0-9]+` for the extension keeps it out.
 */
export async function removePartials(destDir: string, stem: string): Promise<void> {
  const pattern = new RegExp(
    `^${escapeRegex(stem)}\\.(?:f\\d+\\.)?(?:temp\\.)?[A-Za-z0-9]+(?:\\.part|\\.ytdl|\\.part-Frag\\d+)?$`
  )
  let entries: string[]
  try {
    entries = await readdir(destDir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => pattern.test(name))
      .map((name) => rm(join(destDir, name), { force: true }).catch(() => undefined))
  )
}

export function downloadMedia(
  request: IngestRequest,
  tool: IngestTool,
  onProgress: (progress: number, speed: string | null) => void,
  options: { destDir?: string } = {}
): IngestHandle {
  const link = parseLink(request.url)
  if (!link) throw new Error('That is not a link yt-dlp can read')

  const destDir = options.destDir ?? downloadsDir()
  const stem = outputStem(link, request)

  let cancelled = false
  let child: ChildProcess | null = null

  const promise = (async (): Promise<IngestOutcome> => {
    await mkdir(destDir, { recursive: true })
    if (cancelled) throw new CancelledError()

    // The same thing at the same quality is the same file. A second paste of a
    // link costs nothing, which is the difference between a feature and a
    // thing nobody waits for twice.
    const cached = await findCached(destDir, stem)
    if (cached) {
      onProgress(1, null)
      return { path: cached, title: null, cached: true, approximateRange: false, requestedRange: null }
    }

    const built = buildYtDlpArgs(request, { ffmpegPath: FFMPEG_PATH, destDir, stem })

    return new Promise<IngestOutcome>((resolve, reject) => {
      if (cancelled) {
        reject(new CancelledError())
        return
      }

      child = spawn(tool.command, [...(tool.prefixArgs ?? []), ...built.args], {
        windowsHide: true
      })

      const progress = createIngestProgress()
      let filePath: string | null = null
      let title: string | null = null
      let pending = ''
      const stderrLines: string[] = []

      const takeLine = (line: string): void => {
        const marked = readMarkedLine(line)
        if (marked) {
          if (marked.kind === 'file') filePath = marked.value
          else title = marked.value
          return
        }
        const state = progress.push(line)
        // null means yt-dlp has no total yet. Job.progress cannot say "unknown",
        // so the bar stays where it was rather than lying with a zero.
        if (state && state.progress !== null) {
          onProgress(state.progress, formatSpeed(state.speedBps))
        }
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) takeLine(line)
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
        reject(new Error(`Could not start yt-dlp: ${err.message}`))
      })

      child.on('close', (code) => {
        if (pending.trim()) takeLine(pending)

        const discard = (error: Error): void => {
          void removePartials(destDir, stem).then(() => reject(error))
        }

        if (cancelled) {
          discard(new CancelledError())
          return
        }

        if (code === 0) {
          void (async () => {
            // Trust the printed path first; fall back to looking, because a
            // file that already existed can make yt-dlp skip the print.
            const found = filePath ?? (await findCached(destDir, stem))
            if (!found) {
              discard(new Error('yt-dlp finished but did not say where the file is'))
              return
            }
            try {
              if ((await stat(found)).size === 0) throw new Error('empty')
            } catch {
              discard(new Error('yt-dlp finished but the file is missing or empty'))
              return
            }
            onProgress(1, null)
            resolve({
              path: found,
              title,
              cached: false,
              approximateRange: built.approximateRange,
              requestedRange: built.requestedRange
            })
          })()
          return
        }

        discard(new Error(humanError(stderrLines, code)))
      })
    })
  })()

  return {
    promise,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      if (child) killProcess(child)
    }
  }
}
