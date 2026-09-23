/**
 * Drawing the generated cards FOR ONE EXPORT, without touching the edit.
 *
 * Text, colour cards, titles, newspaper clippings and the photo ring are drawn
 * from their spec, and ffmpeg needs them as files. Export used to get those
 * files by calling the editor's own `rebakeGenerated`, which drew them at the
 * PROJECT's canvas and wrote the result back into the edit — and both halves of
 * that were wrong (found by the B2 review):
 *
 * - **The wrong shape.** A 16:9 project exported through the 9:16 preset drew
 *   its title at 1920×1080 and ffmpeg fitted it into a 1080×1920 frame: a small
 *   letterboxed band where a full-bleed card had been on screen. The size check
 *   compared pixel AREA, and 1920×1080 and 1080×1920 have the same area.
 * - **Into the edit.** Every card redrawn was an `update()`: one undo entry per
 *   card, the redo stack wiped, the project marked unsaved — by pressing Export.
 *   And a paper run redrawn for a portrait export was what the landscape
 *   preview then played.
 *
 * So an export draws its own copies, under a key of its own (`<clip>-export`,
 * so no file the edit points at is overwritten), and gets back a COPY of the
 * project pointing at them. The edit is never written to.
 *
 * Pure apart from the drawing, which is passed in: the renderer supplies the
 * canvas bakers, and the tests supply fakes that record what was asked for.
 */

import type { Clip, MediaAsset, Project } from '../timeline'

type Size = { width: number; height: number }
type Sequence = { pattern: string; frames: number } | null

/** The drawing functions, as the renderer has them. */
export interface Bakers {
  text: (spec: NonNullable<Clip['text']>, key: string, width: number, height: number) => Promise<string>
  textSequence: (
    spec: NonNullable<Clip['text']>,
    key: string,
    width: number,
    height: number,
    fps: number,
    maxFrames: number
  ) => Promise<Sequence>
  solid: (spec: NonNullable<Clip['solid']>, key: string, width: number, height: number) => Promise<string>
  title: (spec: NonNullable<Clip['title']>, key: string, width: number, height: number) => Promise<string>
  paper: (spec: NonNullable<Clip['paper']>, key: string, width: number, height: number, frames: number) => Promise<Sequence>
  carousel: (
    spec: NonNullable<Clip['carousel']>,
    key: string,
    photos: string[],
    width: number,
    height: number,
    frames: number,
    fps: number
  ) => Promise<Sequence>
}

/** The key an export's copy of a clip's card is written under. */
export const exportKey = (clipId: string): string => `${clipId}-export`

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/**
 * The sizes an export draws its cards at.
 *
 * **Stills** — text, colour cards, titles, and a text animation's frames — at
 * the export canvas exactly: the shape it will be shown in, and at 4K, 4K words
 * rather than 1080 words blown up by two.
 *
 * **Picture runs** — paper clippings and the photo ring, a picture per frame —
 * in the export's SHAPE, but never with more pixels than the project's own
 * canvas. At 4K a run of photographs per frame is gigabytes of PNG, for detail
 * that was the photographs' to begin with.
 */
export function exportBakeSizes(canvas: Size, exportCanvas: Size): { stills: Size; runs: Size } {
  const projectPixels = Math.max(1, canvas.width * canvas.height)
  const exportPixels = Math.max(1, exportCanvas.width * exportCanvas.height)
  const shrink = Math.min(1, Math.sqrt(projectPixels / exportPixels))
  return {
    stills: { width: even(exportCanvas.width), height: even(exportCanvas.height) },
    runs: { width: even(exportCanvas.width * shrink), height: even(exportCanvas.height * shrink) }
  }
}

/**
 * The project as this export should render it: every generated card drawn for
 * the export's canvas, into files of its own. The edit is not touched.
 *
 * A card that will not draw keeps the asset the edit already had — the last
 * picture of it — rather than failing the export; `onError` hears about it.
 */
export async function bakeForExport(
  project: Project,
  exportCanvas: Size,
  bakers: Bakers,
  onError: (clip: Clip, err: unknown) => void = () => undefined
): Promise<Project> {
  const { fps } = project.settings
  const { stills, runs } = exportBakeSizes(project.settings, exportCanvas)
  const repointed = new Map<string, MediaAsset>()

  for (const clip of project.clips) {
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (!asset) continue
    const key = exportKey(clip.id)
    try {
      if (clip.carousel) {
        const photos = clip.carousel.assetIds
          .map((id) => project.assets.find((a) => a.id === id)?.path)
          .filter((path): path is string => typeof path === 'string' && path.length > 0)
        const run = await bakers.carousel(clip.carousel, key, photos, runs.width, runs.height, clip.duration, fps)
        if (run) repointed.set(asset.id, sequenceAsset(asset, run, runs))
      } else if (clip.paper) {
        const run = await bakers.paper(clip.paper, key, runs.width, runs.height, clip.duration)
        if (run) repointed.set(asset.id, sequenceAsset(asset, run, runs))
      } else if (clip.text) {
        const path = await bakers.text(clip.text, key, stills.width, stills.height)
        // An animated caption's frames are what the export reads; a still one
        // has none, and must not inherit the edit's.
        const run = await bakers.textSequence(clip.text, key, stills.width, stills.height, fps, clip.duration)
        repointed.set(asset.id, {
          ...asset,
          path,
          ...stills,
          frames: run ? { pattern: run.pattern, count: run.frames } : undefined
        })
      } else if (clip.solid) {
        const path = await bakers.solid(clip.solid, key, stills.width, stills.height)
        repointed.set(asset.id, { ...asset, path, ...stills })
      } else if (clip.title) {
        const path = await bakers.title(clip.title, key, stills.width, stills.height)
        repointed.set(asset.id, { ...asset, path, ...stills })
      }
    } catch (err) {
      onError(clip, err)
    }
  }

  if (repointed.size === 0) return project
  return { ...project, assets: project.assets.map((a) => repointed.get(a.id) ?? a) }
}

function sequenceAsset(asset: MediaAsset, run: NonNullable<Sequence>, size: Size): MediaAsset {
  return {
    ...asset,
    path: run.pattern.replace('%05d', '00000'),
    ...size,
    frames: { pattern: run.pattern, count: run.frames }
  }
}
