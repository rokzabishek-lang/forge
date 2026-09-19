import { type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { clipBox } from '@shared/render/plan'
import { useEditor } from '../store'
import { startDrag } from '../drag'

/**
 * Move, scale and rotate a clip on the picture.
 *
 * Every editor does picture-in-picture this way: click the thing, drag it, pull
 * a corner. Sliders in a side panel can express the same numbers but they cannot
 * answer "is it over her face?", which is the only question being asked.
 *
 * The box is drawn from `clipBox` — the same function the renderer composites
 * with — so the handles cannot drift away from what exports.
 */

const MIN_SCALE = 0.02
const MAX_SCALE = 4

export function TransformOverlay({
  clip,
  frame,
  canvas
}: {
  clip: Clip
  /** The finished frame's rectangle inside the preview box, in CSS pixels. */
  frame: { x: number; y: number; width: number; height: number }
  /** The project canvas, in project pixels. */
  canvas: { width: number; height: number }
}): ReactNode {
  const setTransform = useEditor((s) => s.setTransform)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)

  const box = clipBox(clip, canvas)
  const scale = frame.width / canvas.width
  const left = frame.x + box.x * scale
  const top = frame.y + box.y * scale
  const width = box.width * scale
  const height = box.height * scale
  const centre = { x: left + width / 2, y: top + height / 2 }

  /**
   * Run a pointer gesture, batched into one undo step and one action per frame.
   *
   * The per-frame part is not a detail: a high-rate pointer used to fire this
   * handler well over a hundred times a second, and each call re-rendered every
   * panel and repainted the whole canvas. See drag.ts.
   */
  const gesture = (e: ReactPointerEvent, onMove: (ev: PointerEvent) => void): void => {
    startDrag(e, { onFrame: onMove }, begin, commit)
  }

  const startMove = (e: ReactPointerEvent): void => {
    const startX = e.clientX
    const startY = e.clientY
    const baseX = clip.transform?.x ?? 0
    const baseY = clip.transform?.y ?? 0
    /*
     * `x` is in half-canvas units — clipBox offsets by (t.x * canvas.width) / 2 —
     * so a full canvas width of travel is a delta of 2, not 1.
     */
    gesture(e, (ev) => {
      setTransform(clip.id, {
        x: clampOffset(baseX + (2 * (ev.clientX - startX)) / frame.width),
        y: clampOffset(baseY + (2 * (ev.clientY - startY)) / frame.height)
      })
    })
  }

  /**
   * Resize, free-form.
   *
   * Width and height move independently, because a corner that only ever
   * scales both together cannot crop a photo to a shape or squeeze a card into
   * a band — and `scaleY` has existed on the transform all along for exactly
   * that. **Shift keeps the proportions**, the convention every design tool
   * uses, so the old behaviour is still one key away rather than gone.
   *
   * `axis` is what an EDGE handle passes: dragging the side of a box should
   * change its width and leave its height alone, which a corner's arithmetic
   * cannot express on its own.
   *
   * Measured from the centre in each axis separately. Distance rather than
   * signed offset, so dragging a handle past the centre grows the box back out
   * instead of flipping it inside out.
   */
  const startScale =
    (axis: 'both' | 'x' | 'y' = 'both') =>
    (e: ReactPointerEvent): void => {
      const baseX = clip.transform?.scale ?? 1
      const baseY = clip.transform?.scaleY ?? baseX
      const fromX = Math.max(8, Math.abs(e.clientX - centre.x))
      const fromY = Math.max(8, Math.abs(e.clientY - centre.y))

      gesture(e, (ev) => {
        const ratioX = Math.max(8, Math.abs(ev.clientX - centre.x)) / fromX
        const ratioY = Math.max(8, Math.abs(ev.clientY - centre.y)) / fromY

        // Shift on a corner: one ratio drives both, so the shape is kept.
        const shared = axis === 'both' && ev.shiftKey ? Math.max(ratioX, ratioY) : null
        const nextX = axis === 'y' ? baseX : clamp(baseX * (shared ?? ratioX), MIN_SCALE, MAX_SCALE)
        const nextY = axis === 'x' ? baseY : clamp(baseY * (shared ?? ratioY), MIN_SCALE, MAX_SCALE)
        setTransform(clip.id, { scale: nextX, scaleY: nextY })
      })
    }

  const startRotate = (e: ReactPointerEvent): void => {
    const base = clip.transform?.rotation ?? 0
    const from = angle(e.clientX, e.clientY, centre.x, centre.y)
    gesture(e, (ev) => {
      const turned = angle(ev.clientX, ev.clientY, centre.x, centre.y) - from
      // Shift snaps to 15°, the usual convention for a rotate handle.
      const next = ev.shiftKey ? Math.round((base + turned) / 15) * 15 : base + turned
      setTransform(clip.id, { rotation: Math.round(next * 10) / 10 })
    })
  }

  const handle = (cursor: string, style: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 2,
    background: 'rgb(249,115,65)',
    border: '1px solid rgba(10,10,12,0.6)',
    pointerEvents: 'auto',
    cursor,
    ...style
  })

  return (
    <div
      className="absolute"
      style={{
        left,
        top,
        width,
        height,
        transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
        pointerEvents: 'none'
      }}
    >
      <div
        onPointerDown={startMove}
        title="Drag to move"
        style={{
          position: 'absolute',
          inset: 0,
          border: '1px solid rgba(249,115,65,0.9)',
          cursor: 'move',
          pointerEvents: 'auto'
        }}
      />

      {/* Corners resize both axes — hold shift to keep the proportions. */}
      <span onPointerDown={startScale('both')} style={handle('nwse-resize', { left: -5, top: -5 })} />
      <span onPointerDown={startScale('both')} style={handle('nesw-resize', { right: -5, top: -5 })} />
      <span onPointerDown={startScale('both')} style={handle('nesw-resize', { left: -5, bottom: -5 })} />
      <span onPointerDown={startScale('both')} style={handle('nwse-resize', { right: -5, bottom: -5 })} />

      {/* Edges resize one axis, which is the other half of free-form. */}
      <span
        onPointerDown={startScale('x')}
        style={handle('ew-resize', { left: -5, top: '50%', marginTop: -5 })}
      />
      <span
        onPointerDown={startScale('x')}
        style={handle('ew-resize', { right: -5, top: '50%', marginTop: -5 })}
      />
      <span
        onPointerDown={startScale('y')}
        style={handle('ns-resize', { top: -5, left: '50%', marginLeft: -5 })}
      />
      <span
        onPointerDown={startScale('y')}
        style={handle('ns-resize', { bottom: -5, left: '50%', marginLeft: -5 })}
      />

      {/* And a stalk above the box turns it, as every editor puts it. */}
      <span
        style={{
          position: 'absolute',
          left: '50%',
          top: -22,
          width: 1,
          height: 18,
          background: 'rgba(249,115,65,0.6)',
          pointerEvents: 'none'
        }}
      />
      <span
        onPointerDown={startRotate}
        title="Drag to rotate — hold shift for 15° steps"
        style={handle('grab', {
          left: '50%',
          top: -28,
          marginLeft: -5,
          borderRadius: '50%'
        })}
      />
    </div>
  )
}

/** Half-canvas units: ±3 puts a clip well off frame, which is far enough. */
function clampOffset(value: number): number {
  return clamp(Math.round(value * 1000) / 1000, -3, 3)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Degrees, clockwise from the centre. */
function angle(px: number, py: number, cx: number, cy: number): number {
  return (Math.atan2(py - cy, px - cx) * 180) / Math.PI
}
