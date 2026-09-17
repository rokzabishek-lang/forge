/**
 * The yt-dlp command line, built from what the user chose.
 *
 * Pure, so the whole argv can be asserted in a test without a network, a
 * binary or electron — and mutation-checked, which matters because several of
 * these flags are load-bearing in ways that are invisible until they are
 * missing:
 *
 *   `--print` implies `--quiet`, and `--quiet` would silence the progress lines
 *   we parse. `--progress` overrides that. Drop it and the bar sits at 0%.
 *
 *   `--print` also implies `--simulate` unless a later stage is printed. We do
 *   print a later stage, but `--no-simulate` is passed anyway, because a
 *   download that quietly simulates is the worst kind of success.
 *
 *   `-P` and `-o` are separate on purpose. Putting the directory into the `-o`
 *   template means every `%` in the path is read as a template field.
 */

import { parseLink, type ParsedLink } from './url'
import { formatFor, type IngestKind, type Quality } from './format'
import { sectionPlan, type Range } from './section'
import { PROGRESS_TEMPLATE } from './progress'

export type AudioFormat = 'm4a' | 'mp3'

export interface IngestRequest {
  url: string
  kind: IngestKind
  /** Ignored for audio. */
  quality: Quality
  /** Audio only. m4a copies the stream out; mp3 re-encodes through libmp3lame. */
  audioFormat?: AudioFormat
  range?: Range | null
  /** Re-encode at the marks for an exact cut. Slow; see section.ts. */
  exact?: boolean
}

/** Marks the line carrying the finished file's path. */
export const FILE_MARK = '@forgefile@'
/** Marks the line carrying the video's title, for the asset's display name. */
export const TITLE_MARK = '@forgetitle@'

/**
 * What names the file on disk — and what makes two requests the same download.
 *
 * The link's key (a YouTube id, or a slug for anything else) plus everything
 * that changes the bytes: video or audio, which quality, which format, and the
 * range if there is one. Two asks that produce this same stem are one file, so
 * a second paste of the same link at the same quality costs nothing. Every
 * character is from `[A-Za-z0-9._-]`, so it is legal on Windows and needs no
 * escaping in a filtergraph.
 */
export function outputStem(link: ParsedLink, request: IngestRequest): string {
  const what =
    request.kind === 'audio'
      ? `audio-${request.audioFormat ?? 'm4a'}`
      : `video-${request.quality}`
  const range = request.range
    ? `.r${Math.round(Math.min(request.range.startMs, request.range.endMs))}-` +
      `${Math.round(Math.max(request.range.startMs, request.range.endMs))}`
    : ''
  return `${link.key}.${what}${range}`
}

export interface ArgContext {
  /** Our bundled ffmpeg — never one found on PATH, so there is one media pipeline. */
  ffmpegPath: string
  /** Where the file lands. */
  destDir: string
  stem: string
}

export interface BuiltArgs {
  args: string[]
  link: ParsedLink
  stem: string
  /** True when the fast range path was taken and the ends want trimming. */
  approximateRange: boolean
  requestedRange: Range | null
}

export function buildYtDlpArgs(request: IngestRequest, context: ArgContext): BuiltArgs {
  const link = parseLink(request.url)
  if (!link) throw new Error('That is not a link yt-dlp can read')

  const format = formatFor(request.kind, request.quality)
  const section = sectionPlan(request.range ?? null, request.exact ?? false)

  const args: string[] = [
    // The canonical URL, not what was pasted — playlist ids and timestamps are
    // already gone, and `--no-playlist` catches anything a generic link brings.
    link.url,
    '--no-playlist',
    '--ffmpeg-location',
    context.ffmpegPath,

    // Machine-readable progress on stdout. See progress.ts for why this shape.
    '--newline',
    '--progress',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--progress-delta',
    '0.2',

    // The two facts we need back, marked so they cannot be confused with
    // anything else on stdout. after_move is the path AFTER every postprocessor
    // has run — merge, extraction, rename — so it is the file that exists.
    '--print',
    `${TITLE_MARK}%(title)s`,
    '--print',
    `after_move:${FILE_MARK}%(filepath)s`,
    '--no-simulate',

    // Directory and filename kept apart: a `%` in the directory would otherwise
    // be read as a template field.
    '-P',
    context.destDir,
    '-o',
    `${context.stem}.%(ext)s`,

    '-f',
    format.selector,

    // A flaky connection is the common case, not the edge case.
    '--retries',
    '5',
    '--socket-timeout',
    '30'
  ]

  if (format.mergeFormat) args.push('--merge-output-format', format.mergeFormat)

  if (request.kind === 'audio') {
    if ((request.audioFormat ?? 'm4a') === 'mp3') {
      // Re-encode. Our ffmpeg has libmp3lame (checked, not assumed); `0` is
      // the best VBR setting, which for a music bed is the right default.
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0')
    } else {
      // m4a is what YouTube stores, so this copies the stream out untouched.
      args.push('-x', '--audio-format', 'm4a')
    }
  }

  args.push(...section.args)

  return {
    args,
    link,
    stem: context.stem,
    approximateRange: section.approximate,
    requestedRange: section.requested
  }
}

/** Read one of the two marked lines back, or null for anything else. */
export function readMarkedLine(line: string): { kind: 'file' | 'title'; value: string } | null {
  const trimmed = line.trim()
  if (trimmed.startsWith(FILE_MARK)) return { kind: 'file', value: trimmed.slice(FILE_MARK.length) }
  if (trimmed.startsWith(TITLE_MARK)) return { kind: 'title', value: trimmed.slice(TITLE_MARK.length) }
  return null
}

/**
 * Turn yt-dlp's last words into something a person can act on.
 *
 * Its errors arrive as `ERROR: [youtube] abc123: Video unavailable`. The prefix
 * and the extractor tag are noise to a user; the id is already in the job's
 * name. What is left is the actual reason.
 */
export function humanError(stderrTail: string[], exitCode: number | null): string {
  const lines = stderrTail.map((l) => l.trim()).filter(Boolean)
  const error = [...lines].reverse().find((l) => /^ERROR:/i.test(l)) ?? lines.at(-1)
  if (!error) return `yt-dlp exited with code ${exitCode ?? 'unknown'}`
  return error
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^[A-Za-z0-9_-]{11}:\s*/, '')
    .trim()
}
