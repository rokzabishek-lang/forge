import { describe, it, expect } from 'vitest'
import { BACKGROUND_BLUR, DROP_CHOICES, dropPatch } from '@shared/render/dropIntent'
import { isFullFrameMask } from '@shared/render/mask'

const CANVAS = { width: 1080, height: 1920 }

describe('what a drop becomes', () => {
  it('fills the frame by covering it, not by letterboxing into it', () => {
    // A photo that does not match the project's shape would otherwise arrive
    // as a band floating in black, which reads as the drop going wrong.
    const { transform, mask, layer } = dropPatch('fill', CANVAS)
    expect(transform.fit).toBe('cover')
    expect(transform.scale).toBe(1)
    expect(mask).toBeNull()
    expect(layer).toBe('front')
  })

  it('insets a picture-in-picture without covering the frame', () => {
    const { transform, layer } = dropPatch('pip', CANVAS)
    expect(transform.scale).toBeLessThan(1)
    expect(transform.scale).toBeGreaterThan(0)
    // Off-centre, or it is not in a corner.
    expect(Math.abs(transform.x) + Math.abs(transform.y)).toBeGreaterThan(0)
    // It sits OVER what is there, so it must not be sent under it.
    expect(layer).toBe('front')
  })

  it('sends a backdrop underneath, which is the whole point of a backdrop', () => {
    /*
     * A blurred copy composited ABOVE the shot hides the shot. That is the
     * failure that makes this feature look broken rather than subtle, so the
     * patch carries the instruction rather than leaving it to the caller.
     */
    const { transform, mask, layer } = dropPatch('background', CANVAS)
    expect(layer).toBe('back')
    expect(transform.fit).toBe('cover')
    expect(mask?.mode).toBe('blur')
    expect(mask?.blur).toBe(BACKGROUND_BLUR)
  })

  it('gives the backdrop a mask the renderer will actually apply', () => {
    /*
     * `isFullFrameMask` means "this mask is a no-op" and the graph drops it.
     * A blur that covers NOTHING is exactly that, so a backdrop needs a shape
     * covering everything — half extents of 0.5 — rather than no shape at all.
     * Get this wrong and the clip is sent to the back unblurred, which looks
     * like the blur silently failing.
     */
    const { mask } = dropPatch('background', CANVAS)
    expect(isFullFrameMask(mask ?? undefined)).toBe(false)
    expect(mask?.shape.width).toBe(0.5)
    expect(mask?.shape.height).toBe(0.5)
    expect(mask?.shape.invert).toBe(false)
  })

  it('brings it back to the front after a backdrop, so the chip is reversible', () => {
    /*
     * Choosing Fill after Background must not leave the clip on the floor
     * filling the frame behind everything — invisible, and indistinguishable
     * from the button doing nothing.
     */
    expect(dropPatch('fill', CANVAS).layer).toBe('front')
    expect(dropPatch('pip', CANVAS).layer).toBe('front')
  })

  it('clears a mask when a choice does not want one', () => {
    // Choosing "fill" after "blurred background" has to take the blur off,
    // or the chip only ever adds and never undoes.
    expect(dropPatch('fill', CANVAS).mask).toBeNull()
    expect(dropPatch('pip', CANVAS).mask).toBeNull()
  })

  it('offers fill first, since that is what already happened', () => {
    // The clip is filled the moment it lands, so the first chip is the way
    // BACK from the other two rather than a first action.
    expect(DROP_CHOICES[0].id).toBe('fill')
    expect(DROP_CHOICES.map((c) => c.id)).toEqual(['fill', 'pip', 'background'])
  })
})
