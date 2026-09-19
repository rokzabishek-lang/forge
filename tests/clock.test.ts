import { describe, it, expect } from 'vitest'
import { clockStep, frameAt, needsReanchor, type ClockAnchor } from '@shared/render/clock'

/*
 * The timeline owns time.
 *
 * These exist because the rule they replace could not be tested at all: it was
 * a `.find()` inside a requestAnimationFrame callback that picked whichever
 * video element happened to be playing on the lowest track, and both of its
 * failures were invisible from the code.
 */

const at = (frame: number, ms = 1000): ClockAnchor => ({ at: ms, frame })
const FPS = 30

describe('where the playhead should be', () => {
  it('advances with real time, from the anchor', () => {
    expect(frameAt(at(0), 1000, FPS)).toBe(0)
    expect(frameAt(at(0), 2000, FPS)).toBe(30)
    expect(frameAt(at(0), 1500, FPS)).toBe(15)
    // From a non-zero start, which is what resuming mid-timeline looks like.
    expect(frameAt(at(90), 2000, FPS)).toBe(120)
  })

  it('accumulates from one anchor rather than adding up per tick', () => {
    /*
     * Sixty ticks a second is sixty chances to lose a fraction of a frame, and
     * over a long edit that walks measurably away from the audio. Stepping
     * frame by frame and subtracting two timestamps must agree exactly.
     */
    const anchor = at(0)
    let perTick = 0
    for (let i = 1; i <= 600; i++) {
      // A deliberately awkward tick length, as a real display gives.
      perTick = frameAt({ at: anchor.at, frame: perTick }, anchor.at + 16.7, FPS)
    }
    const direct = frameAt(anchor, anchor.at + 600 * 16.7, FPS)
    // 10.02 seconds of real time is 300.6 frames.
    expect(direct).toBe(301)
    /*
     * And the naive version is not slightly wrong, it is twice as fast: one
     * 16.7ms tick is 0.501 frames, which rounds to 1, so six hundred ticks
     * advance six hundred frames instead of three hundred. Ten seconds in, the
     * picture would be ten seconds ahead of the music.
     */
    expect(perTick).toBe(600)
  })

  it('holds still if the clock appears to go backwards', () => {
    // Never jump the playhead into the past over a timestamp we do not trust.
    expect(frameAt(at(60), 500, FPS)).toBe(60)
  })

  it('survives a nonsense timestamp rather than freezing the canvas', () => {
    // A NaN here used to propagate into the playhead and stop the draw loop
    // with nothing in the console to say why.
    expect(frameAt(at(42), Number.NaN, FPS)).toBe(42)
    expect(frameAt({ at: Number.NaN, frame: 42 }, 2000, FPS)).toBe(42)
    expect(frameAt(at(42), 2000, 0)).toBe(42)
  })
})

describe('one tick of playback', () => {
  it('keeps playing in the middle of the timeline', () => {
    expect(clockStep(at(0), 2000, FPS, 300, false)).toEqual({ kind: 'play', frame: 30 })
  })

  it('stops on the last frame at the end', () => {
    expect(clockStep(at(0), 20_000, FPS, 300, false)).toEqual({ kind: 'stop', frame: 300 })
  })

  it('stops the instant it ARRIVES at the end, not a frame later', () => {
    /*
     * A mutation check caught this one asserting nothing: every other test here
     * overshoots the end by seconds, so `>= end` and `> end` behave
     * identically and the boundary was never exercised.
     *
     * `end` is exclusive — `projectDuration` is the last clip's start plus its
     * duration — so frame `end` is already past the last picture. Landing
     * exactly on it must stop, not play one more frame of nothing.
     */
    expect(clockStep(at(0), 11_000, FPS, 300, false)).toEqual({ kind: 'stop', frame: 300 })
    expect(clockStep(at(0), 11_000, FPS, 300, true)).toEqual({ kind: 'loop', frame: 0 })
    // And one frame earlier it is still playing, so the boundary is pinned
    // from both sides rather than just from above.
    expect(clockStep(at(0), 10_966, FPS, 300, false)).toEqual({ kind: 'play', frame: 299 })
  })

  it('goes back to zero when looping', () => {
    expect(clockStep(at(0), 20_000, FPS, 300, true)).toEqual({ kind: 'loop', frame: 0 })
  })

  it('stops rather than looping on an empty timeline', () => {
    /*
     * With `end` at 0 every frame is past the end, so looping here would
     * re-anchor and re-enter every tick — sixty state updates a second for a
     * project with nothing in it.
     */
    expect(clockStep(at(0), 2000, FPS, 0, true)).toEqual({ kind: 'stop', frame: 0 })
  })

  it('runs to the LAST clip on any track, music included', () => {
    /*
     * The end is whatever ends last, picture or sound. `projectDuration` takes
     * the maximum over every clip rather than over the video tracks, so a music
     * bed outlasting the footage keeps the timeline running instead of cutting
     * it off — which is what the model asks for.
     */
    const musicEndsLast = 900 // 30 seconds at 30fps
    // Still running at 19s, where the picture may well have stopped.
    expect(clockStep(at(0), 20_000, FPS, musicEndsLast, false)).toEqual({
      kind: 'play',
      frame: 570
    })
    // And stops on the music's last frame, not before it.
    expect(clockStep(at(0), 32_000, FPS, musicEndsLast, false)).toEqual({
      kind: 'stop',
      frame: 900
    })
  })
})

describe('when to re-anchor', () => {
  it('re-anchors when something else moved the playhead', () => {
    // A scrub, Home, clicking the ruler, revealing a clip. Without this the
    // next tick computes from the stale anchor and drags the playhead back,
    // so scrubbing during playback fights the user.
    expect(needsReanchor(30, 120)).toBe(true)
  })

  it('does not re-anchor on the clock following its own last write', () => {
    expect(needsReanchor(30, 30)).toBe(false)
  })

  it('re-anchors from a standing start', () => {
    expect(needsReanchor(null, 0)).toBe(true)
  })
})
