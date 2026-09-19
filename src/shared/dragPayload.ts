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
  /**
   * `media` is an asset already in the pool; everything else comes from the
   * library and still has to be read off disk.
   */
  kind: AssetKind | 'media'
  /** Path relative to the assets root — or absolute, for a pool asset. */
  file: string
  name: string
  /** Transition id, for transition drags. */
  transitionId?: string
  /** Set for a pool drag: the asset is imported and probed already. */
  assetId?: string
  /** What a pool asset actually is, since `kind` only says where it came from. */
  mediaKind?: 'video' | 'audio' | 'image'
}

/** Which track kinds a payload may be dropped onto. */
export function acceptsKind(payload: DragPayload, trackKind: 'video' | 'audio'): boolean {
  // A pool asset goes where its own kind belongs: a song on an audio track, a
  // photograph on a video one. `kind` alone cannot answer this, which is what
  // `mediaKind` is for.
  if (payload.kind === 'media') {
    return payload.mediaKind === 'audio' ? trackKind === 'audio' : trackKind === 'video'
  }
  if (payload.kind === 'sfx') return trackKind === 'audio'
  if (payload.kind === 'transition') return trackKind === 'video'
  // Props, stickers and titles are pictures: they belong on a video track.
  return trackKind === 'video'
}
