import { basename } from 'node:path'
import type { Project } from '@shared/timeline'
import { framesToSeconds } from '@shared/timeline'
import { buildRenderPlan, type RenderRequest } from '@shared/render/plan'
import { runFfmpeg } from '../ffmpeg/run'
import type { ExecutionHandle } from '../queue'
import type { TransitionDef } from '@shared/transitions/registry'

export interface RenderOptions {
  project: Project
  outputPath: string
  canvas?: { width: number; height: number }
  crf?: number
  preset?: string
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
  const plan = buildRenderPlan(options as RenderRequest)
  const fps = options.project.settings.fps

  return runFfmpeg({
    args: plan.args,
    complete: true,
    durationMs: Math.round(framesToSeconds(plan.durationFrames, fps) * 1000),
    outputPath: options.outputPath,
    onProgress
  })
}

/** A short human label for the queue UI. */
export function describeRender(options: RenderOptions): string {
  const canvas = options.canvas ?? {
    width: options.project.settings.width,
    height: options.project.settings.height
  }
  return `${basename(options.outputPath)} · ${canvas.width}×${canvas.height}`
}
