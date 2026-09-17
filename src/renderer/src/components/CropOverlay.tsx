import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { safeCrop } from '@shared/render/crop'
import type { Clip, CropRect, MediaAsset } from '@shared/timeline'
import { useEditor } from '../store'
import type { ViewTransform } from './Preview'

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'

const HANDLES: { id: Handle; className: string; cursor: string }[] = [
  { id: 'nw', className: '-left-1.5 -top-1.5', cursor: 'nwse-resize' },
  { id: 'ne', className: '-right-1.5 -top-1.5', cursor: 'nesw-resize' },
  { id: 'sw', className: '-left-1.5 -bottom-1.5', cursor: 'nesw-resize' },
  { id: 'se', className: '-right-1.5 -bottom-1.5', cursor: 'nwse-resize' }
]

/**
 * Draggable reframe rectangle over the preview.
 *
 * The aspect ratio is locked — the crop feeds a fixed export canvas, so letting
 * it change shape would silently letterbox the result. Corner handles scale it;
 * the body moves it.
 */
export function CropOverlay({
  clip,
  asset,
  transform
}: {
  clip: Clip
  asset: MediaAsset
  transform: ViewTransform
}): ReactNode {
  const setCrop = useEditor((s) => s.setCrop)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)
  const drag = useRef<{ handle: Handle; startX: number; startY: number; origin: CropRect } | null>(null)

  const crop = clip.crop
  const sourceW = asset.width ?? 0
  const sourceH = asset.height ?? 0

  const onPointerDown = useCallback(
    (handle: Handle) => (event: ReactPointerEvent) => {
      if (!crop) return
      event.preventDefault()
      event.stopPropagation()
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
      drag.current = { handle, startX: event.clientX, startY: event.clientY, origin: { ...crop } }
      begin()
    },
    [crop, begin]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const state = drag.current
      if (!state || !crop) return

      const dx = (event.clientX - state.startX) / transform.scale
      const dy = (event.clientY - state.startY) / transform.scale
      const origin = state.origin

      if (state.handle === 'move') {
        setCrop(clip.id, {
          ...origin,
          x: Math.round(Math.max(0, Math.min(sourceW - origin.width, origin.x + dx))),
          y: Math.round(Math.max(0, Math.min(sourceH - origin.height, origin.y + dy)))
        })
        return
      }

      // Corner resize, aspect locked: drive from the horizontal delta and derive
      // height, so the rectangle can never change shape.
      const ratio = origin.width / origin.height
      const signX = state.handle === 'ne' || state.handle === 'se' ? 1 : -1
      let width = origin.width + dx * signX
      width = Math.max(80, Math.min(width, sourceW, sourceH * ratio))
      const height = width / ratio

      const anchorRight = state.handle === 'nw' || state.handle === 'sw'
      const anchorBottom = state.handle === 'nw' || state.handle === 'ne'

      let x = anchorRight ? origin.x + origin.width - width : origin.x
      let y = anchorBottom ? origin.y + origin.height - height : origin.y

      x = Math.max(0, Math.min(x, sourceW - width))
      y = Math.max(0, Math.min(y, sourceH - height))

      /*
       * Stored as the renderer will use it.
       *
       * The clamping above happens in floating point and is rounded afterwards,
       * so a rectangle dragged to the very edge could round back out past it —
       * and the handles then showed numbers the export silently disagreed with.
       * Running the result through the same function the render plan uses means
       * what the overlay draws is what gets cut.
       */
      const source = { width: sourceW, height: sourceH }
      // null means "this covers the whole frame", which the renderer answers by
      // emitting no crop at all. Mid-drag the rectangle still has to be drawn,
      // so it becomes the full frame rather than disappearing under the pointer.
      const safe = safeCrop({ x, y, width, height }, source) ?? {
        x: 0,
        y: 0,
        width: sourceW,
        height: sourceH
      }
      setCrop(clip.id, safe)
    },
    [clip.id, crop, setCrop, sourceW, sourceH, transform.scale]
  )

  const onPointerUp = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    // One undo entry per gesture, not per pointer event.
    commit()
  }, [commit])

  if (!crop) return null

  const left = transform.offsetX + crop.x * transform.scale
  const top = transform.offsetY + crop.y * transform.scale
  const width = crop.width * transform.scale
  const height = crop.height * transform.scale

  return (
    <div
      className="absolute cursor-move border-2 border-flame-500"
      style={{ left, top, width, height }}
      onPointerDown={onPointerDown('move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Rule-of-thirds guides make a reframe judgement much easier. */}
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div className="absolute left-1/3 top-0 h-full w-px bg-white/50" />
        <div className="absolute left-2/3 top-0 h-full w-px bg-white/50" />
        <div className="absolute left-0 top-1/3 h-px w-full bg-white/50" />
        <div className="absolute left-0 top-2/3 h-px w-full bg-white/50" />
      </div>

      {HANDLES.map((handle) => (
        <div
          key={handle.id}
          className={`absolute size-3 rounded-sm border border-ink-950 bg-flame-500 ${handle.className}`}
          style={{ cursor: handle.cursor }}
          onPointerDown={onPointerDown(handle.id)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      ))}

      <div className="pointer-events-none absolute -top-6 left-0 rounded bg-ink-950/90 px-1.5 py-0.5 text-[10px] text-ink-200">
        {crop.width}×{crop.height}
      </div>
    </div>
  )
}
