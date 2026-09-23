import { basename } from 'node:path'
import type { Project } from '@shared/timeline'
import { framesToSeconds } from '@shared/timeline'
import { buildRenderPlan, type RenderRequest } from '@shared/render/plan'
import { CancelledError, runFfmpeg, type RunHandle } from '../ffmpeg/run'
import { analyseSteady } from './steady'
import type { ExecutionHandle } from '../queue'
import type { TransitionDef } from '@shared/transitions/registry'
import type { EncodeSpec } from '@shared/render/encode'
import type { FrameRange } from '@shared/render/exportShape'

export interface RenderOptions {
  project: Project
  outputPath: string
  canvas?: { width: number; height: number }
  crf?: number
  preset?: string
  encode?: EncodeSpec
  range?: FrameRange
  /** The running ffmpeg's chroma-key distance scale (render/keyScale.ts). */
  keyScale?: number
  /** Where steady clips' motion analysis is kept between exports (render/steady.ts). */
  steadyDir?: string
  subtitlesPath?: string
  fontsDir?: string
  captionOverlay?: { listPath: string; y: number; height: number }
  resolveAsset?: (relativePath: string) => string
  extraTransitions?: TransitionDef[]
}

/**
 * Turns a timeline into a running ffmpeg render with progress and cancellation.
 *
 * This is the whole reason the job queue was worth keeping from the converter
 * era: an NLE's export is a queued ffmpeg job with progress and cancel.
 */
export function startRender(
  options: RenderOptions,
  onProgress: (progress: number, speed: string | null) => void
): ExecutionHandle {
  const fps = options.project.settings.fps
  const run = (request: RenderRequest, progress: typeof onProgress): RunHandle => {
    const plan = buildRenderPlan(request)
    return runFfmpeg({
      args: plan.args,
      complete: true,
      durationMs: Math.round(framesToSeconds(plan.durationFrames, fps) * 1000),
      outputPath: options.outputPath,
      onProgress: progress
    })
  }

  const steadying = options.steadyDir !== undefined && options.project.clips.some((c) => c.steady)
  if (!steadying) return run(options as RenderRequest, onProgress)

  /*
   * A steady clip needs its motion analysed before the render can use it, so
   * the job runs in two parts: the analysis (the first quarter of the bar) and
   * the render (the rest). One cancel stops whichever is running.
   */
  const ANALYSIS_SHARE = 0.25
  let cancelled = false
  let current: { cancel: () => void } | null = null
  const promise = (async (): Promise<void> => {
    const analysis = analyseSteady(options.project, options.steadyDir!, (f) => onProgress(f * ANALYSIS_SHARE, null))
    current = analysis
    const steady = await analysis.promise
    if (cancelled) throw new CancelledError()
    const render = run({ ...options, steady } as RenderRequest, (p, speed) =>
      onProgress(ANALYSIS_SHARE + p * (1 - ANALYSIS_SHARE), speed)
    )
    current = render
    await render.promise
  })()
  return {
    promise,
    cancel: () => {
      cancelled = true
      current?.cancel()
    }
  }
}

/** A short human label for the queue UI. */
export function describeRender(options: RenderOptions): string {
  const canvas = options.canvas ?? {
    width: options.project.settings.width,
    height: options.project.settings.height
  }
  return `${basename(options.outputPath)} · ${canvas.width}×${canvas.height}`
}
