import { describe, it, expect } from 'vitest'
import {
  moveMany,
  removeMany,
  rippleDelete,
  gapAt,
  closeGap,
  copySelection,
  pasteClipboard,
  duplicateSelection,
  drawsItself
} from '@shared/edit/recipes'
import { collapsesIntoBurst } from '@shared/edit/coalesce'
import { emptyProject, type Clip, type Project } from '@shared/timeline'

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'a', trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(clips: Clip[]): Project {
  return {
    ...emptyProject(),
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false }
    ],
    clips
  }
}

/** Three shots in a row on one track: 0-30, 30-60, 60-90. */
function row(): Project {
  return project([
    clip({ id: 'a', start: 0 }),
    clip({ id: 'b', start: 30 }),
    clip({ id: 'c', start: 60 })
  ])
}

const at = (p: Project, id: string): Clip => p.clips.find((c) => c.id === id)!

describe('moving several clips at once', () => {
  it('keeps the arrangement', () => {
    const next = moveMany(row(), ['a', 'c'], 15)
    expect(at(next, 'a').start).toBe(15)
    expect(at(next, 'c').start).toBe(75)
    // The gap between the two that moved is unchanged.
    expect(at(next, 'c').start - at(next, 'a').start).toBe(60)
    // And the one that was not selected has not moved.
    expect(at(next, 'b').start).toBe(30)
  })

  it('clamps at the start of the timeline as a GROUP, not one by one', () => {
    /*
     * The bug this is here to prevent: clamping each clip separately at zero
     * squashes the arrangement against the start, so two clips a second apart
     * arrive on top of each other and one of them is now hidden under the
     * other. The group stops when its EARLIEST member reaches zero.
     */
    const next = moveMany(row(), ['a', 'b'], -500)
    expect(at(next, 'a').start).toBe(0)
    expect(at(next, 'b').start).toBe(30)
    expect(at(next, 'b').start - at(next, 'a').start).toBe(30)
  })

  it('does nothing for an empty selection or a zero move', () => {
    const before = row()
    expect(moveMany(before, [], 20)).toBe(before)
    expect(moveMany(before, ['a'], 0)).toBe(before)
  })
})

describe('delete and ripple delete', () => {
  it('plain delete leaves the gap, deliberately', () => {
    /*
     * Not an oversight. Everything the automations place sits on a beat, and
     * rippling by default would drag the rest of the reel off the music — the
     * same reason `anchorTransition` exists. The gap is the honest result.
     */
    const next = removeMany(row(), ['b'])
    expect(next.clips.map((c) => c.id)).toEqual(['a', 'c'])
    expect(at(next, 'c').start).toBe(60)
  })

  it('ripple delete closes the hole on that track', () => {
    const next = rippleDelete(row(), ['b'])
    expect(at(next, 'a').start).toBe(0)
    expect(at(next, 'c').start).toBe(30)
  })

  it('ripples several holes without double-counting', () => {
    // Removing two of three leaves the third at the very start.
    const next = rippleDelete(row(), ['a', 'b'])
    expect(at(next, 'c').start).toBe(0)
  })

  it('never moves a clip on another track', () => {
    const p = project([
      clip({ id: 'a', start: 0 }),
      clip({ id: 'b', start: 30 }),
      clip({ id: 'music', trackId: 'a1', start: 0, duration: 200 }),
      clip({ id: 'title', trackId: 'v2', start: 45, duration: 20 })
    ])
    const next = rippleDelete(p, ['a'])
    expect(at(next, 'b').start).toBe(0)
    // The bed and the title stay exactly where the edit left them.
    expect(at(next, 'music').start).toBe(0)
    expect(at(next, 'title').start).toBe(45)
  })

  it('never moves a LAYER, which shares its frames on purpose', () => {
    /*
     * A grid piece, a sticker over a face, the incoming half of a transition:
     * these overlap their neighbours by design, and sliding one back to close
     * a gap tears the arrangement apart. The same distinction `moveClip`
     * already makes for a drag.
     */
    const p = project([
      clip({ id: 'gone', start: 0, duration: 30 }),
      clip({ id: 'piece1', start: 60, duration: 40 }),
      clip({ id: 'piece2', start: 70, duration: 40 })
    ])
    const next = rippleDelete(p, ['gone'])
    expect(at(next, 'piece1').start).toBe(60)
    expect(at(next, 'piece2').start).toBe(70)
  })

  it('leaves the project alone when nothing matches', () => {
    const before = row()
    expect(rippleDelete(before, ['nope'])).toBe(before)
    expect(removeMany(before, [])).toBe(before)
  })
})

describe('gaps', () => {
  const holed = (): Project =>
    project([clip({ id: 'a', start: 0, duration: 30 }), clip({ id: 'b', start: 90, duration: 30 })])

  it('finds the empty run between two clips', () => {
    expect(gapAt(holed(), 'v1', 50)).toEqual({ trackId: 'v1', start: 30, duration: 60 })
  })

  it('finds the run before the first clip', () => {
    const p = project([clip({ id: 'a', start: 40 })])
    expect(gapAt(p, 'v1', 10)).toEqual({ trackId: 'v1', start: 0, duration: 40 })
  })

  it('is not a gap inside a clip, or past the end of the track', () => {
    // Inside `a`, and after `b` — the second is not a hole, it is where the
    // track stops, and "closing" it would mean nothing.
    expect(gapAt(holed(), 'v1', 10)).toBeNull()
    expect(gapAt(holed(), 'v1', 500)).toBeNull()
    expect(gapAt(holed(), 'a1', 50)).toBeNull()
  })

  it('closing one pulls everything after it back', () => {
    const p = holed()
    const gap = gapAt(p, 'v1', 50)!
    const next = closeGap(p, gap)
    expect(at(next, 'a').start).toBe(0)
    expect(at(next, 'b').start).toBe(30)
  })
})

describe('copy, paste and duplicate', () => {
  it('pastes at the playhead keeping relative offsets', () => {
    const p = row()
    const board = copySelection(p, ['a', 'c'])!
    expect(board.anchor).toBe(0)

    const { project: next, ids } = pasteClipboard(p, board, 200)
    expect(ids).toHaveLength(2)
    const pasted = ids.map((id) => at(next, id))
    expect(pasted[0].start).toBe(200)
    // 'c' was 60 frames after 'a' and still is.
    expect(pasted[1].start).toBe(260)
  })

  it('gives every copy a new id and leaves the originals alone', () => {
    const p = row()
    const board = copySelection(p, ['a'])!
    const { project: next, ids } = pasteClipboard(p, board, 200)

    expect(ids[0]).not.toBe('a')
    expect(next.clips).toHaveLength(4)
    expect(at(next, 'a').start).toBe(0)
    // Every id in the project is still unique.
    expect(new Set(next.clips.map((c) => c.id)).size).toBe(next.clips.length)
  })

  it('does not overwrite what is already in the lane', () => {
    // Pasting onto an occupied stretch walks forward rather than landing on
    // top of a clip and hiding it.
    const p = row()
    const board = copySelection(p, ['a'])!
    const { project: next, ids } = pasteClipboard(p, board, 0)
    expect(at(next, ids[0]).start).toBeGreaterThanOrEqual(90)
  })

  it('drops the incoming transition, which described a neighbour it has left', () => {
    const p = project([clip({ id: 'a', start: 30, transitionIn: { id: 'dissolve', durationFrames: 10 } })])
    const board = copySelection(p, ['a'])!
    const { project: next, ids } = pasteClipboard(p, board, 300)
    expect(at(next, ids[0]).transitionIn).toBeUndefined()
    // The original keeps its own.
    expect(at(next, 'a').transitionIn).toBeDefined()
  })

  it('asks for a fresh bake for anything that draws itself', () => {
    /*
     * Two clips must never share one baked PNG: editing the words on one would
     * silently change the other, and deleting either would take the picture
     * out from under the survivor.
     */
    const p = project([
      clip({ id: 'plain', start: 0 }),
      clip({
        id: 'words', start: 60, trackId: 'v2',
        text: { ...({} as NonNullable<Clip['text']>), version: 1 }
      })
    ])
    expect(drawsItself(at(p, 'plain'))).toBe(false)
    expect(drawsItself(at(p, 'words'))).toBe(true)

    const board = copySelection(p, ['plain', 'words'])!
    const { toBake } = pasteClipboard(p, board, 300)
    expect(toBake).toHaveLength(1)
    expect(toBake[0].from.id).toBe('words')
  })

  it('duplicates directly after the selection, not wherever there is room', () => {
    /*
     * The gesture means "one more of THESE, here". A contiguous row cannot
     * tell the two apart — the end of the selection and the first free frame
     * are the same place — so this leaves a hole earlier in the track that a
     * search for room would fall into. The mutation run is what found that;
     * the earlier fixture passed with the anchor deleted entirely.
     */
    const p = project([
      clip({ id: 'early', start: 0, duration: 30 }),
      clip({ id: 'late', start: 200, duration: 30 })
    ])
    const { project: next, ids } = duplicateSelection(p, ['late'])
    expect(at(next, ids[0]).start).toBe(230)
    expect(at(next, ids[0]).start).not.toBe(30)
  })

  it('copies nothing when nothing is selected', () => {
    expect(copySelection(row(), [])).toBeNull()
    expect(duplicateSelection(row(), []).ids).toEqual([])
  })

  it('keeps a layer stacked rather than turning it into a sequence', () => {
    /*
     * A sticker pasted over a shot should still be over a shot. Deciding from
     * whether it was stacked WHERE IT CAME FROM, because that is what makes it
     * a layer — not which track it happens to be on.
     */
    const p = project([
      clip({ id: 'shot', trackId: 'v1', start: 0, duration: 100 }),
      clip({ id: 'sticker', trackId: 'v1', start: 10, duration: 20 })
    ])
    const board = copySelection(p, ['sticker'])!
    const { project: next, ids } = pasteClipboard(p, board, 50)
    const pasted = at(next, ids[0])
    expect(pasted.start).toBe(50)
    // It climbed to another lane rather than being pushed past the shot.
    expect(pasted.trackId).not.toBe('v1')
  })
})

describe('collapsing a burst of keystrokes into one undo step', () => {
  const S0 = { n: 0 }
  const S1 = { n: 1 }

  it('keeps the first keystroke of a burst', () => {
    // Otherwise the whole edit has no undo point at all.
    expect(
      collapsesIntoBurst({
        burstDepth: undefined,
        depthBefore: 5,
        depthAfter: 6,
        topEntry: S0,
        stateBefore: S0
      })
    ).toBe(false)
  })

  it('collapses a keystroke that continues an uninterrupted run', () => {
    expect(
      collapsesIntoBurst({
        burstDepth: 5,
        depthBefore: 5,
        depthAfter: 6,
        topEntry: S0,
        stateBefore: S0
      })
    ).toBe(true)
  })

  it('ends the run when something else has edited in between', () => {
    /*
     * Measured in the harness: typing, moving a clip, then typing again used to
     * collapse across the move and throw ITS undo point away — one undo took
     * back the move as well as the keystroke.
     */
    expect(
      collapsesIntoBurst({
        burstDepth: 5,
        depthBefore: 6, // a move pushed an entry since this burst last did
        depthAfter: 7,
        topEntry: S0,
        stateBefore: S0
      })
    ).toBe(false)
  })

  it('refuses when the top of the stack is not the entry this edit made', () => {
    // Depth alone cannot tell one entry from another; identity can.
    expect(
      collapsesIntoBurst({
        burstDepth: 5,
        depthBefore: 5,
        depthAfter: 6,
        topEntry: S1,
        stateBefore: S0
      })
    ).toBe(false)
  })

  it('refuses when the edit pushed nothing, or pushed more than one', () => {
    for (const depthAfter of [5, 7]) {
      expect(
        collapsesIntoBurst({
          burstDepth: 5,
          depthBefore: 5,
          depthAfter,
          topEntry: S0,
          stateBefore: S0
        }),
        `depthAfter ${depthAfter}`
      ).toBe(false)
    }
  })
})
