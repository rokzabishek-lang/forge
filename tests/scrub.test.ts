import { describe, it, expect } from 'vitest'
import {
  scrubStep,
  NO_SCRUB,
  SCRUB_BURST_MS,
  SCRUB_INTERVAL_MS,
  SCRUB_BURSTS_PER_SECOND,
  type ScrubState
} from '@shared/render/scrub'

/*
 * The scrub throttle, as a sequence of decisions.
 *
 * The audible behaviour — does dragging the playhead sound right — can only be
 * judged by ear. What can be pinned is the thing that makes it sound right or
 * wrong: how often a burst is allowed, and when one is refused. Both failure
 * modes are specific and both are worse than silence, so both have a test.
 */

/** Run a series of (frame, time) pairs through and collect what fired. */
function drag(steps: { frame: number; at: number }[], from: ScrubState = NO_SCRUB): number[] {
  let state = from
  const fired: number[] = []
  for (const step of steps) {
    const { burst, next } = scrubStep(state, step.frame, step.at)
    state = next
    if (burst) fired.push(step.at)
  }
  return fired
}

describe('the scrub throttle', () => {
  it('sounds the first move immediately', () => {
    // Waiting out an interval before the first burst would make a short drag
    // silent, which is most drags.
    expect(drag([{ frame: 10, at: 1000 }])).toEqual([1000])
  })

  it('refuses a playhead that has not moved', () => {
    /*
     * The draw loop runs on every animation frame whether anything changed or
     * not, so without this a preview sitting still would replay the same 80 ms
     * twelve times a second forever — a stuck note, and one that sounds like
     * broken playback rather than like a scrub.
     */
    const steps = Array.from({ length: 30 }, (_, i) => ({ frame: 10, at: 1000 + i * 100 }))
    expect(drag(steps)).toEqual([1000])
  })

  it('thins a fast drag to its rate rather than smearing', () => {
    // A drag reporting a new frame every 8 ms for a second.
    const steps = Array.from({ length: 125 }, (_, i) => ({ frame: i, at: i * 8 }))
    const fired = drag(steps)

    expect(fired.length).toBeLessThanOrEqual(SCRUB_BURSTS_PER_SECOND + 1)
    expect(fired.length).toBeGreaterThanOrEqual(SCRUB_BURSTS_PER_SECOND - 1)

    // And no two bursts are closer than the interval, so they cannot overlap.
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i] - fired[i - 1]).toBeGreaterThanOrEqual(SCRUB_INTERVAL_MS)
    }
  })

  it('lets a slow drag through on every move', () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({ frame: i, at: i * 500 }))
    expect(drag(steps)).toHaveLength(5)
  })

  it('keeps its state when it declines, so a refusal cannot reset the clock', () => {
    // Assigning the returned state unconditionally is the calling pattern, and
    // it has to be safe: a declined frame that reset `lastAt` would let the
    // next one through early and the throttle would do nothing under load.
    const first = scrubStep(NO_SCRUB, 5, 1000)
    expect(first.burst).toBe(true)

    const declined = scrubStep(first.next, 6, 1010)
    expect(declined.burst).toBe(false)
    expect(declined.next).toBe(first.next)

    // Still refused just short of the interval, and allowed just past it.
    // Either side rather than exactly on it: the interval is 1000/12, and
    // `1000 + 1000/12 - 1000` is not `1000/12`.
    expect(scrubStep(declined.next, 7, 1000 + SCRUB_INTERVAL_MS - 1).burst).toBe(false)
    expect(scrubStep(declined.next, 7, 1000 + SCRUB_INTERVAL_MS + 1).burst).toBe(true)
  })

  it('leaves a gap longer than the burst it allows', () => {
    /*
     * The one relationship that has to hold between the two constants: if a
     * burst were longer than the gap, bursts would overlap and the scrub would
     * be heard as a continuous smear lagging behind the mouse.
     */
    expect(SCRUB_BURST_MS).toBeLessThan(SCRUB_INTERVAL_MS)
    // And long enough to recognise: below about 50 ms a pitched sound is a click.
    expect(SCRUB_BURST_MS).toBeGreaterThanOrEqual(50)
  })
})
