import type { Bakers } from '@shared/render/exportBake'
import { bakeText, bakeTextSequence } from './textCanvas'
import { bakePaperSequence } from './paperCanvas'
import { bakeCarouselSequence } from './carouselCanvas'

/**
 * The canvas drawing an export's cards go through — the same functions the
 * editor's own rebake uses, handed to `bakeForExport` so that one draws into
 * files of the export's own and never writes to the edit. See
 * src/shared/render/exportBake.ts.
 */
export const liveBakers: Bakers = {
  text: (spec, key, width, height) => bakeText(spec, key, width, height),
  textSequence: (spec, key, width, height, fps, maxFrames) =>
    bakeTextSequence(spec, key, width, height, fps, maxFrames),
  solid: (spec, key, width, height) =>
    window.forge.renderSolid({ color: spec.color, opacity: spec.opacity, clipId: key, width, height }),
  title: (spec, key, width, height) =>
    window.forge.renderTitle({ template: spec.template, texts: spec.texts, clipId: key, width, height }),
  paper: (spec, key, width, height, frames) => bakePaperSequence(spec, key, width, height, frames),
  carousel: (spec, key, photos, width, height, frames, fps) =>
    bakeCarouselSequence(spec, key, photos, width, height, frames, fps)
}
