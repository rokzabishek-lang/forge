/**
 * Whether a burst of small edits should collapse into one undo step.
 *
 * Typing a caption is dozens of changes and one intention, so the history has
 * to fold them together. The first attempt did it by holding a transaction open
 * — `begin()` on the first keystroke, `commit()` from a timer — and that was
 * wrong in a way nothing caught for a long time: the pending snapshot is one
 * module-level variable, so for those 160 milliseconds EVERY other edit in the
 * app joined the same transaction. Type a caption, drag a clip straight
 * afterwards, and one undo took back both. Type into two clips in a row and the
 * second `begin()` overwrote the first's snapshot, so undo jumped back past
 * work it had no business touching.
 *
 * The replacement pushes an ordinary entry for every keystroke and REMOVES the
 * one it just pushed while a burst continues. That inverts the hazard: instead
 * of a window in which unrelated work is silently captured, there is a single
 * decision — is the entry on top of the stack the one I just made, as part of
 * a run nobody interrupted — and it is this function.
 *
 * All three conditions matter, and each has a bug behind it:
 *
 * - **A burst must be in progress.** The first keystroke keeps its entry, or
 *   the whole edit has no undo point at all.
 * - **Nothing else may have edited since.** Checked by DEPTH: a move between
 *   two keystrokes pushes an entry of its own, and collapsing across it would
 *   throw that entry away — measured, and it lost the move's undo point.
 * - **The top of the stack must be the entry this edit created.** Checked by
 *   identity, because depth alone cannot tell one entry from another.
 */
export function collapsesIntoBurst(args: {
  /** History depth when this burst last pushed, or undefined if none is open. */
  burstDepth: number | undefined
  depthBefore: number
  depthAfter: number
  /** The newest history entry, and the state this edit started from. */
  topEntry: unknown
  stateBefore: unknown
}): boolean {
  if (args.burstDepth === undefined) return false
  if (args.burstDepth !== args.depthBefore) return false
  if (args.depthAfter !== args.depthBefore + 1) return false
  return args.topEntry === args.stateBefore
}
