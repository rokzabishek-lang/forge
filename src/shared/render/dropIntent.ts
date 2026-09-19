import type { Mask } from './mask'
import type { Transform } from '../timeline'
import { DEFAULT_PIP, pipTransform } from './layout'

/**
 * What something BECOMES when it is dropped on the picture.
 *
 * Dropping a photo onto the canvas has no single right answer — it might be
 * the shot, or a corner inset over the shot, or a soft backdrop behind it —
 * and an editor that silently picks one is wrong two times in three. So it
 * picks the commonest and offers the others, the way a paste in a slide
 * program offers what kind of paste it was.
 *
 * Pure, and separate from the panel that shows it: what each choice DOES is
 * arithmetic, and arithmetic is the part worth testing. Every one of them
 * writes ordinary transform and mask values, so the result stays draggable and
 * editable exactly like a clip placed any other way — none of these is a mode.
 */

export type DropIntent = 'fill' | 'pip' | 'background'

export interface DropChoice {
  id: DropIntent
  label: string
  hint: string
}

/**
 * Offered in the order they are wanted, commonest first.
 *
 * `fill` is already applied by the time the chip appears — the clip has to
 * look like something the moment it lands — so choosing it is the way BACK
 * from one of the others, not a first action.
 */
export const DROP_CHOICES: readonly DropChoice[] = [
  { id: 'fill', label: 'Fill the frame', hint: 'Cover the whole picture' },
  { id: 'pip', label: 'Picture in picture', hint: 'A corner inset over what is behind' },
  { id: 'background', label: 'Blurred background', hint: 'Soft, behind everything else' }
]

/** How hard to blur a backdrop. The same units as a blur mask's `blur`. */
export const BACKGROUND_BLUR = 40

export interface DropPatch {
  transform: Transform
  /**
   * A mask to set, or null to clear whatever is there.
   *
   * A blurred backdrop is a blur mask whose shape covers the WHOLE frame. Half
   * extents of 0.5 do exactly that — the same trick the rounded-corner inset
   * uses — and it matters that the shape covers rather than being absent,
   * because `isFullFrameMask` treats a mask covering nothing as a no-op and
   * drops it from the graph entirely.
   */
  mask: Mask | null
  /**
   * Put it underneath everything rather than on top.
   *
   * Only a backdrop wants this, and it is the whole point of a backdrop: a
   * blurred copy composited ABOVE the shot hides the shot, which is the
   * failure that makes the feature look broken rather than subtle.
   */
  sendToBack: boolean
}

export function dropPatch(
  intent: DropIntent,
  canvas: { width: number; height: number }
): DropPatch {
  if (intent === 'pip') {
    return {
      transform: pipTransform({ ...DEFAULT_PIP, canvas }),
      mask: null,
      sendToBack: false
    }
  }

  const cover: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' }

  if (intent === 'background') {
    return {
      transform: cover,
      mask: {
        mode: 'blur',
        blur: BACKGROUND_BLUR,
        shape: {
          kind: 'rectangle',
          x: 0.5,
          y: 0.5,
          width: 0.5,
          height: 0.5,
          rotation: 0,
          feather: 0,
          invert: false
        }
      },
      sendToBack: true
    }
  }

  return { transform: cover, mask: null, sendToBack: false }
}
