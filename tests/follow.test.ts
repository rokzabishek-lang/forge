import { describe, it, expect } from 'vitest'
import {
  followScroll,
  zoomToFit,
  PAGE_MARGIN,
  MIN_ZOOM,
  MAX_ZOOM
} from '@shared/edit/follow'

const view = (over: Partial<Parameters<typeof followScroll>[0]> = {}): Parameters<typeof followScroll>[0] => ({
  playheadPx: 100,
  scrollLeft: 0,
  viewWidth: 800,
  contentWidth: 4000,
  playing: false,
  ...over
})

describe('following the playhead', () => {
  it('does nothing while the playhead is in view', () => {
    /*
     * The common case, and it has to cost nothing: assigning `scrollLeft`
     * every frame — even to the value it already holds — fights anyone
     * dragging the scrollbar, which is why this returns null rather than a
     * position.
     */
    expect(followScroll(view({ playheadPx: 400 }))).toBeNull()
    expect(followScroll(view({ playheadPx: 400, playing: true }))).toBeNull()
  })

  it('pages while playing, so the lane is not scrolling under a still playhead', () => {
    // Walked off the right-hand edge: jump so it sits a tenth in, with the
    // whole width to cross before the next jump.
    const next = followScroll(view({ playheadPx: 1200, playing: true }))
    expect(next).toBe(1200 - 800 * PAGE_MARGIN)

    // And from there it has the rest of the view to run through.
    expect(followScroll(view({ playheadPx: 1300, scrollLeft: next!, playing: true }))).toBeNull()
    expect(followScroll(view({ playheadPx: 1900, scrollLeft: next!, playing: true }))).toBeNull()
  })

  it('centres when paused, because a seek means "show me this"', () => {
    expect(followScroll(view({ playheadPx: 1200 }))).toBe(1200 - 400)
  })

  it('never scrolls past either end', () => {
    // At the very start there is nothing to the left to show.
    expect(followScroll(view({ playheadPx: 5, scrollLeft: 900 }))).toBe(0)
    // At the very end, the clamp lands where the lane already is, which is
    // "nothing to do" rather than a scroll to the same place.
    expect(followScroll(view({ playheadPx: 3999, scrollLeft: 3200 }))).toBeNull()
    expect(followScroll(view({ playheadPx: 3999, scrollLeft: 0 }))).toBe(3200)
  })

  it('treats a playhead on the boundary as off screen', () => {
    // Otherwise it hovers half-visible at the edge and never triggers.
    expect(followScroll(view({ playheadPx: 800, scrollLeft: 0 }))).not.toBeNull()
    expect(followScroll(view({ playheadPx: 0, scrollLeft: 0 }))).toBeNull()
  })

  it('refuses to guess with no width to work with', () => {
    expect(followScroll(view({ viewWidth: 0 }))).toBeNull()
  })
})

describe('zoom to fit', () => {
  it('fits the whole project in the width, with a little room to spare', () => {
    /*
     * Strictly inside, not flush: a project fitted to exactly the width ends
     * with its last clip against the edge, where the trim handle is half
     * off-screen and there is nowhere to drop anything after it. Pinned as a
     * range because "less than or equal" passed with the margin deleted.
     */
    const width = 900
    const zoom = zoomToFit(3000, width)
    const fitted = 3000 * zoom

    expect(fitted).toBeLessThan(width)
    expect(width - fitted).toBeGreaterThan(width * 0.01)
    expect(width - fitted).toBeLessThan(width * 0.1)
  })

  it('stays inside bounds a timeline can still be used at', () => {
    /*
     * A four-hour project at the honest ratio would put every clip on a
     * fraction of a pixel and make the timeline unclickable; a one-frame
     * project would ask for a zoom of nine hundred.
     */
    expect(zoomToFit(60 * 60 * 30 * 4, 900)).toBe(MIN_ZOOM)
    expect(zoomToFit(2, 100_000)).toBe(MAX_ZOOM)
  })

  it('leaves an empty timeline at its own zoom rather than snapping to a bound', () => {
    expect(zoomToFit(0, 900)).toBe(1)
    expect(zoomToFit(1, 900)).toBe(1)
  })

  it('refuses to guess with no width', () => {
    expect(zoomToFit(3000, 0)).toBe(MIN_ZOOM)
  })
})
