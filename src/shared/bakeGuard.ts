/**
 * Which bake of a clip is the live one.
 *
 * Both sequence bakes — text and clippings — clear a clip's frames and then
 * write them back one at a time, awaiting the main process for each. Nothing
 * stopped two bakes of the SAME clip overlapping, and when they did the older
 * one carried on writing into the directory the newer one had just cleared.
 *
 * The loud symptom was an ENOENT: the newer bake's `rm` landing between the
 * older one's `mkdir` and its `writeFile`, measured on Windows at startup with
 * a restored project. That one is only the lucky case. The quiet case is worse
 * and leaves no trace — the sequence ends up a mix of two different renders,
 * and the export replays whichever frames happened to win.
 *
 * A generation per clip settles it: the newest bake owns the clip, and an older
 * one checks before every write and stops. `isBaking` exists because a
 * superseded bake reports nothing, and a caller that treats "no result" as
 * failure would otherwise throw away the frames of the bake that replaced it.
 *
 * Lives in `shared` rather than beside the two callers in `renderer` only
 * because it is pure and that is the half of the tree the test project
 * compiles — `tsconfig.node.json` covers main, preload, shared and tests, so a
 * renderer-only module cannot be imported by a test at all.
 */

/** The latest bake token handed out per clip. */
const generations = new Map<string, number>()

/** How many bakes are still running per clip, so callers can tell why one returned nothing. */
const inFlight = new Map<string, number>()

/**
 * Claim a clip for a new bake, superseding anything already running on it.
 *
 * Pair every call with `endBake` in a `finally`, or `isBaking` stays true for
 * a clip nothing is baking and the caller's failure handling never runs again.
 */
export function beginBake(clipId: string): number {
  const token = (generations.get(clipId) ?? 0) + 1
  generations.set(clipId, token)
  inFlight.set(clipId, (inFlight.get(clipId) ?? 0) + 1)
  return token
}

/** This bake is over, whether it finished, failed or was superseded. */
export function endBake(clipId: string): void {
  const left = (inFlight.get(clipId) ?? 1) - 1
  if (left > 0) inFlight.set(clipId, left)
  else inFlight.delete(clipId)
}

/**
 * Has a newer bake claimed this clip since `token` was issued?
 *
 * Checked before every write rather than once at the top: the whole point is
 * that a bake yields to the main process on each frame, and the supersession
 * can land in any one of those gaps.
 */
export function isSuperseded(clipId: string, token: number): boolean {
  return (generations.get(clipId) ?? 0) !== token
}

/** Is any bake still running for this clip? */
export function isBaking(clipId: string): boolean {
  return (inFlight.get(clipId) ?? 0) > 0
}

/** Tests only: forget every clip, so one case cannot leak into the next. */
export function resetBakeGuard(): void {
  generations.clear()
  inFlight.clear()
}
