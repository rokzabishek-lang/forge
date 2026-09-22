/**
 * Keeping the playhead on screen.
 *
 * The lane never scrolled itself. Press play on anything longer than the
 * visible width and the playhead walked off the right-hand edge and kept going
 * — playback continued, the picture updated, and the timeline sat showing the
 * first eight seconds of a ninety-second reel. Every NLE follows the playhead;
 * this is the arithmetic of how.
 *
 * Two behaviours, because two situations:
 *
 * - **Playing: page.** When the playhead leaves the view, jump so it sits near
 *   the left edge and let it cross the whole width before jumping again. The
 *   alternative — keeping it centred every frame — means the lane scrolls
 *   continuously under a still playhead, which is exactly as readable as
 *   reading out of the window of a moving train. Premiere calls this page
 *   scrolling and it is the default there for the same reason.
 * - **Paused: centre.** A seek, a click on a clip, a *reveal* from the pool —
 *   these are "show me this", and the middle of the view is where you look.
 *
 * Pure and in frames-to-pixels only, so the rule can be tested without a DOM.
 */

/** Where the playhead lands after a page: a tenth in, with room to run. */
export const PAGE_MARGIN = 0.1

export interface FollowView {
  /** The playhead's position in lane pixels. */
  playheadPx: number
  /** Current horizontal scroll of the lane. */
  scrollLeft: number
  /** Visible width of the lane, in pixels. */
  viewWidth: number
  /** Total scrollable width, so a page cannot ask for more than exists. */
  contentWidth: number
  playing: boolean
}

/**
 * The scroll position the lane should move to, or null to leave it alone.
 *
 * Null rather than "the current value" so a caller can tell *nothing to do*
 * from *scroll to exactly where you already are* — assigning `scrollLeft`
 * unconditionally every frame fights a user who is dragging the scrollbar.
 */
export function followScroll(view: FollowView): number | null {
  if (view.viewWidth <= 0) return null

  const left = view.scrollLeft
  const right = left + view.viewWidth
  // A small inset, so a playhead sitting exactly on the edge counts as off it:
  // otherwise it hovers half-visible at the boundary and never triggers.
  const inside = view.playheadPx >= left + 2 && view.playheadPx <= right - 2
  if (inside) return null

  const wanted = view.playing
    ? view.playheadPx - view.viewWidth * PAGE_MARGIN
    : view.playheadPx - view.viewWidth / 2

  const most = Math.max(0, view.contentWidth - view.viewWidth)
  const next = Math.round(Math.max(0, Math.min(most, wanted)))
  // Already there — which happens at the very start and the very end, where
  // the clamp lands on the position the lane is already at.
  return next === Math.round(left) ? null : next
}

/**
 * The zoom that fits a whole project in the visible width.
 *
 * Zoom here is pixels per frame, so this is simply width over length — with a
 * margin so the last clip does not end flush against the edge, and bounds so
 * an empty project does not ask for infinite zoom and a four-hour one does not
 * ask for a zoom of zero (which would stack every clip on one pixel and make
 * the timeline unclickable).
 */
export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 12

export function zoomToFit(durationFrames: number, viewWidth: number): number {
  if (!(viewWidth > 0)) return MIN_ZOOM
  // An empty or one-frame project fits at any zoom; keep the one it has rather
  // than snapping to a bound that says nothing.
  if (!(durationFrames > 1)) return 1
  const fit = (viewWidth * 0.96) / durationFrames
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit))
}
