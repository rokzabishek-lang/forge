import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '@shared/timeline'
import { framesToSeconds } from '@shared/timeline'
import { videoInputArgs } from '@shared/render/plan'
import { sourceFramesFor } from '@shared/render/speed'
import { canSteady, hasVidstab, steadyDetectFilter, steadyKey, type SteadyPlan } from '@shared/render/steady'
import { FFMPEG_PATH } from '../ffmpeg/paths'
import { CancelledError, runFfmpeg, type RunHandle } from '../ffmpeg/run'

/**
 * Steadying, in the main process: which stabiliser this build has, and the
 * analysis pass vidstab needs before an export (shared/render/steady.ts).
 */

let vidstabOnce: Promise<boolean> | null = null

/**
 * Does THIS ffmpeg have vidstab? Asked once per process; a listing that could
 * not be read answers no and is asked again next time (the encoder probe's
 * lesson), cleared in a `then` so a callback that fires early cannot beat it.
 */
export function probeVidstab(): Promise<boolean> {
  if (vidstabOnce) return vidstabOnce
  const listing = new Promise<boolean | null>((resolve) => {
    execFile(
      FFMPEG_PATH,
      ['-hide_banner', '-filters'],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : hasVidstab(String(stdout)))
    )
  })
  const answer: Promise<boolean> = listing.then((has) => {
    if (has !== null) return has
    if (vidstabOnce === answer) vidstabOnce = null
    return false
  })
  vidstabOnce = answer
  return answer
}

/** The motion file's name for one stretch of one file: the same frames, the same file. */
export function steadyFileName(key: string): string {
  return `${createHash('sha1').update(key).digest('hex').slice(0, 24)}.trf`
}

/**
 * The analysis every steady clip in a project needs, as one cancellable step.
 *
 * vidstab's first pass runs over exactly the frames the export will decode —
 * the plan's own `videoInputArgs` — and writes the motion it found to a file
 * in `dir`, named for those frames, so a second export of the same clip does
 * not analyse again. A clip whose analysis fails is steadied with deshake
 * rather than failing the export; a cancel stops everything.
 */
export function analyseSteady(
  project: Project,
  dir: string,
  onProgress: (fraction: number) => void
): { promise: Promise<Record<string, SteadyPlan>>; cancel: () => void } {
  let cancelled = false
  let running: RunHandle | null = null
  const fps = project.settings.fps

  const promise = (async (): Promise<Record<string, SteadyPlan>> => {
    const work = project.clips
      .map((clip) => ({ clip, asset: project.assets.find((a) => a.id === clip.assetId) }))
      .filter(({ clip, asset }) => clip.steady && canSteady(clip, asset))
    const plans: Record<string, SteadyPlan> = {}
    if (work.length === 0) return plans
    if (!(await probeVidstab())) {
      for (const { clip } of work) plans[clip.id] = { kind: 'deshake' }
      return plans
    }
    await mkdir(dir, { recursive: true })
    for (const [index, { clip, asset }] of work.entries()) {
      if (cancelled) throw new CancelledError()
      const frames = sourceFramesFor(clip)
      const file = steadyFileName(steadyKey(clip, frames, asset!, fps))
      const path = join(dir, file)
      const done = await stat(path).then((s) => s.size > 0).catch(() => false)
      if (!done) {
        running = runFfmpeg({
          args: [...videoInputArgs(clip, asset!, fps), '-vf', steadyDetectFilter(file), '-f', 'null', '-'],
          durationMs: Math.round(framesToSeconds(frames, fps) * 1000),
          // A failed or cancelled analysis leaves no half-written file to be reused.
          outputPath: path,
          cwd: dir,
          onProgress: (p) => onProgress((index + p) / work.length)
        })
        try {
          await running.promise
        } catch (err) {
          if (cancelled || err instanceof CancelledError) throw new CancelledError()
          plans[clip.id] = { kind: 'deshake' }
          continue
        } finally {
          running = null
        }
      }
      plans[clip.id] = { kind: 'vidstab', transforms: path }
      onProgress((index + 1) / work.length)
    }
    return plans
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      running?.cancel()
    }
  }
}
