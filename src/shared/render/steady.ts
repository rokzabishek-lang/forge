/**
 * Steady — take a handheld shake out of a clip (FIX.md B3).
 *
 * Two stabilisers, and a measured reason to prefer one. On a clip jittered by
 * a known hand-held shake, the spread of a marker's position (px, across/down):
 *
 *   as shot                      7.6 / 6.0
 *   `deshake`                    4.1 / 4.1   one pass
 *   `vidstab`, smoothing 30      0.5 / 0.6   two passes, and faster to apply
 *
 * `vidstab` needs its first pass — `vidstabdetect`, which writes the motion it
 * found to a file — run over EXACTLY the frames the export will decode, so the
 * main process runs it with the plan's own input arguments (`videoInputArgs`)
 * and hands the plan the file. `deshake` needs nothing and is the fallback: on
 * a build without libvidstab, or a clip the analysis could not be run for.
 * Which build has which is measured on the machine (main/render/steady.ts).
 *
 * The preview cannot stabilise: there is no stabiliser in a browser. So a
 * steady clip plays as shot until it is exported, and the panel says so.
 */

import type { Clip, MediaAsset } from '../timeline'
import { escapeFilterPath } from '../captions/timeline'

/** How a steady clip is steadied in one export. */
export type SteadyPlan = { kind: 'vidstab'; transforms: string } | { kind: 'deshake' }

/** Frames either side the smoothing averages over. 30 took the marker to half a pixel. */
export const STEADY_SMOOTHING = 30

/** Footage only: a photograph has no shake, and the app draws the rest itself. */
export function canSteady(
  clip: Pick<Clip, 'adjustment' | 'text' | 'title' | 'paper' | 'carousel' | 'solid'>,
  asset: Pick<MediaAsset, 'kind' | 'hasVideo' | 'frames'> | undefined
): boolean {
  if (clip.adjustment || clip.text || clip.title || clip.paper || clip.carousel || clip.solid) return false
  return Boolean(asset && asset.kind === 'video' && asset.hasVideo && !asset.frames)
}

/**
 * The first pass, as a filter: find the motion, write it to `file`.
 *
 * `file` is a bare name — the main process runs this with the cache folder as
 * its working directory, so no drive-letter colon ever reaches the parser.
 */
export function steadyDetectFilter(file: string): string {
  return `vidstabdetect=result=${file}:shakiness=5:accuracy=15`
}

/**
 * The export's step. `optzoom=1` zooms just enough that the moved picture
 * never shows its edge — the stabiliser's own answer to the blank border.
 */
export function steadyFilter(plan: SteadyPlan): string {
  if (plan.kind === 'deshake') return 'deshake'
  return `vidstabtransform=input=${escapeFilterPath(plan.transforms)}:smoothing=${STEADY_SMOOTHING}:optzoom=1:interpol=bicubic`
}

/**
 * What a clip's analysis depends on — the file and the exact stretch of it the
 * export decodes. The same key is the same frames, so the analysis is reused.
 */
export function steadyKey(clip: Pick<Clip, 'inPoint'>, sourceFrames: number, asset: Pick<MediaAsset, 'path' | 'size'>, fps: number): string {
  return JSON.stringify([asset.path, asset.size, clip.inPoint, sourceFrames, fps])
}

/** Whether a build's `-filters` listing has both halves of vidstab. */
export function hasVidstab(filters: string): boolean {
  return /\svidstabdetect\s/.test(filters) && /\svidstabtransform\s/.test(filters)
}
