/**
 * Editing more than one clip at a time.
 *
 * The timeline could select exactly one clip, had no clipboard, and had no way
 * to close a gap — so rearranging four shots meant four drags, and copying a
 * title to the end of a reel meant making a new one and retyping it. None of
 * that is exotic: it is the first ten minutes of anyone arriving from CapCut.
 *
 * Pure functions over a Project, for the same reason `withClipSpeed` and
 * `addTransition` are: the interesting part of each of these is not the click,
 * it is what happens to everything ELSE — and that is the part that has to be
 * tested rather than looked at. The store's job is to call one of these and
 * hand the result to `update()`, which makes each gesture exactly one undo
 * entry however many clips it touched.
 */

import {
  clipEnd,
  findFreeSlot,
  overlapsOn,
  stackedSlot,
  type Clip,
  type Frames,
  type Project
} from '../timeline'

/** A fresh id in the shape the rest of the app makes them. */
function freshId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * A clip that PAINTS itself from a spec rather than showing a file.
 *
 * These carry an asset that the app bakes for them, so a copy needs its own —
 * two clips sharing one baked PNG means editing the words on one silently
 * changes the other, and deleting either takes the picture out from under the
 * survivor.
 */
export function drawsItself(clip: Clip): boolean {
  return Boolean(clip.text ?? clip.paper ?? clip.carousel ?? clip.solid ?? clip.title)
}

/* --------------------------------------------------------------- moving */

/**
 * Move a set of clips together, keeping their shape.
 *
 * The offset is applied to every clip, so the group arrives in the same
 * arrangement it left in — which is the whole reason to select several. It is
 * clamped as a GROUP rather than per clip: clamping each one separately at
 * frame 0 would squash the arrangement against the start of the timeline, and
 * the two clips a user had carefully placed a second apart would arrive on top
 * of each other.
 */
export function moveMany(
  project: Project,
  ids: readonly string[],
  deltaFrames: Frames
): Project {
  const moving = new Set(ids)
  const chosen = project.clips.filter((c) => moving.has(c.id))
  if (chosen.length === 0 || deltaFrames === 0) return project

  const earliest = Math.min(...chosen.map((c) => c.start))
  const shift = Math.max(deltaFrames, -earliest)
  if (shift === 0) return project

  return {
    ...project,
    clips: project.clips.map((c) =>
      moving.has(c.id) ? { ...c, start: c.start + shift } : c
    )
  }
}

/* -------------------------------------------------------------- deleting */

/** Remove clips. Gaps stay: see `rippleDelete` for why that is deliberate. */
export function removeMany(project: Project, ids: readonly string[]): Project {
  const going = new Set(ids)
  if (going.size === 0) return project
  return { ...project, clips: project.clips.filter((c) => !going.has(c.id)) }
}

/**
 * Remove clips AND close the hole each one leaves, on its own track.
 *
 * **Plain Delete deliberately leaves the gap.** Everything the automations
 * place sits on a beat, a drop or a sung word, and rippling by default would
 * drag the rest of the reel off the music — which is the same reason
 * `anchorTransition` exists. So this is the second gesture (Premiere's
 * ⇧Delete), chosen rather than assumed.
 *
 * Two rules keep it from doing damage:
 *
 * - **Only the clip's own track moves.** Rippling every track would slide a
 *   music bed and a caption that had nothing to do with the cut.
 * - **A clip that overlaps something is a LAYER and is never moved.** A grid
 *   piece, a sticker over a face, the incoming half of a transition — these
 *   share their frames on purpose, and sliding one to close a gap would tear
 *   the arrangement apart. The same distinction `moveClip` already makes.
 */
export function rippleDelete(project: Project, ids: readonly string[]): Project {
  const going = new Set(ids)
  const doomed = project.clips.filter((c) => going.has(c.id))
  if (doomed.length === 0) return project

  let clips = project.clips.filter((c) => !going.has(c.id))

  // Track by track, latest first: closing a later hole cannot then move the
  // clips an earlier hole is about to be measured against.
  const byTrack = new Map<string, Clip[]>()
  for (const clip of doomed) {
    byTrack.set(clip.trackId, [...(byTrack.get(clip.trackId) ?? []), clip])
  }

  for (const [trackId, removed] of byTrack) {
    for (const clip of [...removed].sort((a, b) => b.start - a.start)) {
      const span = clip.duration
      clips = clips.map((c) => {
        if (c.trackId !== trackId || c.start < clipEnd(clip)) return c
        // A layer keeps its frames: it is stacked, not queued.
        const layered = clips.some(
          (other) =>
            other.id !== c.id &&
            other.trackId === c.trackId &&
            c.start < clipEnd(other) &&
            clipEnd(c) > other.start
        )
        return layered ? c : { ...c, start: Math.max(0, c.start - span) }
      })
    }
  }

  return { ...project, clips }
}

/**
 * The empty run around `frame` on a track, or null when there is no hole.
 *
 * Clicking a gap has to select something, and a gap is not an object — so it is
 * derived on demand from its neighbours. Bounded by the clip before it and the
 * clip after it; a gap with nothing after it is the end of the track and is not
 * a hole at all, it is just where the track stops.
 */
export function gapAt(
  project: Project,
  trackId: string,
  frame: Frames
): { trackId: string; start: Frames; duration: Frames } | null {
  const lane = project.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
  if (lane.length === 0) return null

  const covering = lane.find((c) => frame >= c.start && frame < clipEnd(c))
  if (covering) return null

  const after = lane.find((c) => c.start > frame)
  if (!after) return null

  const before = [...lane].reverse().find((c) => clipEnd(c) <= frame)
  const start = before ? clipEnd(before) : 0
  const duration = after.start - start
  return duration > 0 ? { trackId, start, duration } : null
}

/** Close a gap: everything after it on that track slides back by its length. */
export function closeGap(
  project: Project,
  gap: { trackId: string; start: Frames; duration: Frames }
): Project {
  if (gap.duration <= 0) return project
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.trackId === gap.trackId && c.start >= gap.start + gap.duration
        ? { ...c, start: Math.max(0, c.start - gap.duration) }
        : c
    )
  }
}

/* ------------------------------------------------------------- clipboard */

export interface Clipboard {
  clips: Clip[]
  /** Where the earliest of them sat, so relative offsets survive a paste. */
  anchor: Frames
}

/** Copy, keeping each clip's offset from the earliest one in the set. */
export function copySelection(project: Project, ids: readonly string[]): Clipboard | null {
  const wanted = new Set(ids)
  const clips = project.clips.filter((c) => wanted.has(c.id))
  if (clips.length === 0) return null
  return { clips: clips.map((c) => ({ ...c })), anchor: Math.min(...clips.map((c) => c.start)) }
}

export interface PasteResult {
  project: Project
  /** The new clips' ids, so the caller can select what it just made. */
  ids: string[]
  /**
   * Clips that need a fresh asset baked, paired with the id they were copied
   * from. Baking is asynchronous and belongs to the store; deciding WHICH need
   * it is a property of the clip and belongs here.
   */
  toBake: { clipId: string; from: Clip }[]
}

/**
 * Paste at a frame, keeping the arrangement.
 *
 * Every clip lands at `frame + (its own start - the anchor)`, so a pair a
 * second apart is still a second apart. Its own track first; if that lane is
 * busy at the moment it wants, the same rule the rest of the timeline uses
 * decides where it goes instead — a layer climbs (`stackedSlot`), a sequence
 * clip walks forward (`findFreeSlot`) — so a paste never silently overwrites
 * and never silently stacks something that was meant to be a cut.
 */
export function pasteClipboard(
  project: Project,
  clipboard: Clipboard,
  frame: Frames
): PasteResult {
  const ids: string[] = []
  const toBake: { clipId: string; from: Clip }[] = []
  let next = project

  for (const source of [...clipboard.clips].sort((a, b) => a.start - b.start)) {
    const id = freshId('clip')
    const wanted = Math.max(0, frame + (source.start - clipboard.anchor))

    /*
     * Was this clip stacked where it came from?
     *
     * A grid piece or a sticker overlapped its neighbours on purpose, and it
     * should still overlap them after a paste. A clip that stood alone in its
     * lane is a shot, and two shots at the same moment on one track is a
     * collision rather than a composite.
     */
    const wasLayered =
      overlapsOn(project, source.trackId, source.start, source.duration, source.id).length > 0

    const landing = wasLayered
      ? (stackedSlot(next, source.trackId, wanted, source.duration) ?? {
          trackId: source.trackId,
          start: findFreeSlot(next, source.trackId, wanted, source.duration)
        })
      : {
          trackId: source.trackId,
          start: findFreeSlot(next, source.trackId, wanted, source.duration)
        }

    const copy: Clip = {
      ...source,
      id,
      start: landing.start,
      trackId: landing.trackId,
      /*
       * A pasted clip is not the incoming half of a transition.
       *
       * `transitionIn` describes an overlap with whatever used to be before it,
       * and the copy has landed somewhere else entirely — keeping it would
       * blend the new clip against a neighbour it has no relationship with.
       */
      transitionIn: undefined
    }

    if (drawsItself(source)) toBake.push({ clipId: id, from: source })

    next = { ...next, clips: [...next.clips, copy] }
    ids.push(id)
  }

  return { project: next, ids, toBake }
}

/**
 * Duplicate in place: each copy lands directly after the clip it came from.
 *
 * Distinct from copy-then-paste, which lands at the playhead. ⌘D means *one
 * more of these, here* — the gesture for repeating a sticker down a reel or
 * doubling a beat — so the anchor is the end of the selection rather than
 * wherever the playhead happens to be.
 */
export function duplicateSelection(project: Project, ids: readonly string[]): PasteResult {
  const clipboard = copySelection(project, ids)
  if (!clipboard) return { project, ids: [], toBake: [] }
  const last = Math.max(...clipboard.clips.map(clipEnd))
  return pasteClipboard(project, clipboard, last)
}
