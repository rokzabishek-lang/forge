/**
 * Pointer drags, at the speed of the screen rather than the speed of the mouse.
 *
 * A trackpad or a gaming mouse delivers pointermove at 120Hz or more, and every
 * one of those events was previously running a full store write, a re-render of
 * every panel subscribed to the project, and a complete repaint of the canvas.
 * On a 60Hz display at least half of that work was thrown away before anything
 * reached a pixel — and the half that survived arrived late, which is exactly
 * what "not smooth" feels like.
 *
 * Every professional editor solves this the same way: sample the pointer as fast
 * as the system offers it, but only ACT once per displayed frame. Nothing is
 * dropped — the newest position always wins — and the work per frame is capped
 * at exactly one of everything.
 *
 * The gesture also batches the whole drag into a single undo entry, so a drag
 * across the screen is one Cmd-Z rather than four hundred.
 *
 * Pacing against the frame rather than against a timer is deliberate. Where
 * animation frames are throttled — a hidden window, a pane that is not
 * compositing — the screen is not updating either, so applying the drag more
 * often would produce no visible result for real work. The release always
 * applies the final sample, so a slow frame rate costs smoothness and never
 * costs accuracy: the thing being dragged still lands exactly where it was let
 * go. Measured in the browser harness, whose pane runs animation frames at
 * roughly 1Hz: the drag was coarse, and the final position was exact.
 */

export interface DragHandle {
  /** Latest pointer event, already coalesced to one per frame. */
  onFrame: (event: PointerEvent) => void
  /** Called once when the drag ends, after the last frame has been applied. */
  onEnd?: () => void
}

/**
 * Start an rAF-coalesced pointer drag.
 *
 * `begin` and `commit` are the store's transaction pair; passing them is what
 * turns the drag into one history entry.
 */
export function startDrag(
  event: { preventDefault: () => void; stopPropagation: () => void },
  handle: DragHandle,
  begin?: () => void,
  commit?: () => void
): void {
  event.preventDefault()
  event.stopPropagation()
  begin?.()

  let pending: PointerEvent | null = null
  let frame = 0
  let done = false

  const flush = (): void => {
    frame = 0
    const next = pending
    pending = null
    if (next && !done) handle.onFrame(next)
  }

  const move = (ev: PointerEvent): void => {
    // Keep only the newest position. An older one is not information any more,
    // it is just work that would be overwritten a millisecond later.
    pending = ev
    if (frame === 0) frame = requestAnimationFrame(flush)
  }

  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    /*
     * Apply the last sample before finishing.
     *
     * Releasing between two frames would otherwise discard the final few
     * pixels of travel, and the thing being dragged would settle a step behind
     * where it was let go — a small wrongness that reads as sloppiness.
     */
    if (frame !== 0) cancelAnimationFrame(frame)
    if (pending) handle.onFrame(pending)
    done = true
    pending = null
    handle.onEnd?.()
    commit?.()
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}
