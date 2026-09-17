import type { DragEvent } from 'react'
import { DRAG_MIME, type DragPayload } from '@shared/dragPayload'

// Re-exported so components have one import for drag handling.
export { DRAG_MIME, acceptsKind, type DragPayload } from '@shared/dragPayload'

export function setDragPayload(event: DragEvent, payload: DragPayload): void {
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
  // A readable fallback, so dropping into a text field does something sane.
  event.dataTransfer.setData('text/plain', payload.name)
  event.dataTransfer.effectAllowed = 'copy'
}

export function readDragPayload(event: DragEvent): DragPayload | null {
  const raw = event.dataTransfer.getData(DRAG_MIME)
  if (!raw) return null
  try {
    return JSON.parse(raw) as DragPayload
  } catch {
    return null
  }
}

/** True while a library item — rather than an external file — is being dragged. */
export function isAssetDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(DRAG_MIME)
}
