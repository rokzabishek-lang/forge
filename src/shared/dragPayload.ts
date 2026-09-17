import type { AssetKind } from './assets/catalog'

/**
 * What a library item carries while being dragged.
 *
 * A private MIME type rather than text/plain: the timeline must distinguish an
 * internal library drag from a file dropped in from Finder, because they are
 * different operations — one places a catalog asset, the other imports media.
 */
export const DRAG_MIME = 'application/x-forge-asset'

export interface DragPayload {
  kind: AssetKind
  /** Path relative to the assets root. */
  file: string
  name: string
  /** Transition id, for transition drags. */
  transitionId?: string
}

/** Which track kinds a payload may be dropped onto. */
export function acceptsKind(payload: DragPayload, trackKind: 'video' | 'audio'): boolean {
  if (payload.kind === 'sfx') return trackKind === 'audio'
  if (payload.kind === 'transition') return trackKind === 'video'
  // Props, stickers and titles are pictures: they belong on a video track.
  return trackKind === 'video'
}
