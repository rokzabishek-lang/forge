import { type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { maskGeometry, type Mask } from '@shared/render/mask'
import { useEditor } from '../store'
import { startDrag } from '../drag'

/**
 * The mask, on the picture.
 *
 * A mask is a shape over somebody's face or the corner of a room, and the only
 * question being asked of it is "is it covering the right thing?" — which a
 * column of numeric fields cannot answer however precise it is. So the shape is
 * dragged where it is seen, and the panel keeps the numbers for when they are
 * genuinely wanted.
 *
 * The dashed outline is drawn from `maskGeometry`, the same function that
 * builds the export's `geq` expression, so the ring here and the edge in the
 * file cannot come apart.
 */

/** Everything outside the shape, dimmed, so the region reads at a glance. */
const VEIL = 'rgba(8,8,10,0.55)'

export function MaskOverlay({
  clip,
  mask,
  frame,
  canvas
}: {
  clip: Clip
  mask: Mask
  /** The finished frame's rectangle inside the preview box, in CSS pixels. */
  frame: { x: number; y: number; width: number; height: number }
  /** The project canvas, in project pixels. */
  canvas: { width: number; height: number }
}): ReactNode {
  const setMaskShape = useEditor((s) => s.setMaskShape)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)

  const scale = frame.width / canvas.width
  const g = maskGeometry(mask.shape, canvas.width, canvas.height)
  const cx = frame.x + g.cx * scale
  const cy = frame.y + g.cy * scale
  const rx = g.rx * scale
  const ry = g.ry * scale
  const degrees = mask.shape.rotation

  /**
   * One undo step for the whole drag, and one store write per displayed frame.
   * See drag.ts for why the second half matters as much as the first.
   */
  const gesture = (e: ReactPointerEvent, onMove: (ev: PointerEvent) => void): void => {
    startDrag(e, { onFrame: onMove }, begin, commit)
  }

  const startMove = (e: ReactPointerEvent): void => {
    const fromX = e.clientX
    const fromY = e.clientY
    const baseX = mask.shape.x
    const baseY = mask.shape.y
    gesture(e, (ev) => {
      setMaskShape(clip.id, {
        // Fractions of the canvas, so the shape stays put through an aspect
        // change instead of sliding off the side of the frame.
        x: clamp01(baseX + (ev.clientX - fromX) / frame.width),
        y: clamp01(baseY + (ev.clientY - fromY) / frame.height)
      })
    })
  }

  /**
   * Resize from an edge handle.
   *
   * The handles sit on the shape's own axes, so a rotated mask resizes along
   * the direction it looks like it should rather than along the screen.
   */
  const startResize = (axis: 'x' | 'y') => (e: ReactPointerEvent): void => {
    const base = axis === 'x' ? mask.shape.width : mask.shape.height
    const radians = (degrees * Math.PI) / 180
    const from = along(e.clientX - cx, e.clientY - cy, radians, axis)
    const span = axis === 'x' ? frame.width : frame.height
    gesture(e, (ev) => {
      const now = along(ev.clientX - cx, ev.clientY - cy, radians, axis)
      const delta = (now - from) / span
      const next = clamp(base + delta, 0.01, 2)
      setMaskShape(clip.id, axis === 'x' ? { width: next } : { height: next })
    })
  }

  const startRotate = (e: ReactPointerEvent): void => {
    const base = degrees
    const from = angleAt(e.clientX, e.clientY, cx, cy)
    gesture(e, (ev) => {
      const now = angleAt(ev.clientX, ev.clientY, cx, cy)
      let next = base + (now - from)
      // Snap to the straight angles — a horizon that is one degree off is worse
      // than one that is ten degrees off, because it reads as a mistake.
      const nearest = Math.round(next / 45) * 45
      if (Math.abs(next - nearest) < 3) next = nearest
      setMaskShape(clip.id, { rotation: Math.round(next) })
    })
  }

  const feather = Math.max(g.featherX * scale, 1)

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg
        className="absolute inset-0 size-full"
        style={{ overflow: 'visible' }}
        aria-hidden
      >
        <defs>
          {/*
           * The veil is a rectangle with the shape punched out of it, blurred by
           * the feather amount. Seeing the softness rather than reading it as a
           * number is the whole reason the control is worth having.
           */}
          <mask id={`forge-mask-${clip.id}`} maskUnits="userSpaceOnUse">
            <rect x={0} y={0} width="100%" height="100%" fill="white" />
            <g
              transform={`translate(${cx} ${cy}) rotate(${degrees})`}
              filter={feather > 1.5 ? `blur(${(feather / 2).toFixed(1)}px)` : undefined}
            >
              <Shape mask={mask} rx={rx} ry={ry} frame={frame} fill="black" />
            </g>
          </mask>
        </defs>
        <rect
          x={frame.x}
          y={frame.y}
          width={frame.width}
          height={frame.height}
          fill={VEIL}
          mask={`url(#forge-mask-${clip.id})`}
        />
        {/* The edge itself, so the shape is legible against any picture. */}
        <g transform={`translate(${cx} ${cy}) rotate(${degrees})`} fill="none">
          <Shape mask={mask} rx={rx} ry={ry} frame={frame} stroke="rgba(0,0,0,0.55)" width={3} />
          <Shape mask={mask} rx={rx} ry={ry} frame={frame} stroke="#f5f5f7" width={1.25} dashed />
        </g>
      </svg>

      {/* Drag anywhere inside to move it. */}
      <div
        onPointerDown={startMove}
        style={{
          left: cx - rx,
          top: cy - ry,
          width: rx * 2,
          height: ry * 2,
          transform: `rotate(${degrees}deg)`
        }}
        className="pointer-events-auto absolute cursor-move"
      />

      {mask.shape.kind !== 'linear' && (
        <>
          <Handle x={cx} y={cy} dx={rx} dy={0} angle={degrees} onDown={startResize('x')} cursor="ew-resize" />
          <Handle x={cx} y={cy} dx={0} dy={ry} angle={degrees} onDown={startResize('y')} cursor="ns-resize" />
        </>
      )}
      <Handle
        x={cx}
        y={cy}
        dx={0}
        dy={-(mask.shape.kind === 'linear' ? 28 : ry + 22)}
        angle={degrees}
        onDown={startRotate}
        cursor="grab"
        ring
      />
    </div>
  )
}

/** The outline, in the shape's own rotated frame with the centre at the origin. */
function Shape({
  mask,
  rx,
  ry,
  frame,
  fill,
  stroke,
  width,
  dashed
}: {
  mask: Mask
  rx: number
  ry: number
  frame: { width: number; height: number }
  fill?: string
  stroke?: string
  width?: number
  dashed?: boolean
}): ReactNode {
  const paint = {
    fill: fill ?? 'none',
    stroke,
    strokeWidth: width,
    strokeDasharray: dashed ? '5 4' : undefined
  }
  if (mask.shape.kind === 'ellipse') return <ellipse cx={0} cy={0} rx={rx} ry={ry} {...paint} />
  if (mask.shape.kind === 'rectangle') {
    // rx/ry on a <rect> are corner radii, and SVG names them the same as the
    // half-extents above — hence the separate name. Matches the export's rule:
    // a fraction of the shorter half-extent.
    const corner = Math.max(0, Math.min(1, mask.shape.radius ?? 0)) * Math.min(rx, ry)
    return (
      <rect
        x={-rx}
        y={-ry}
        width={rx * 2}
        height={ry * 2}
        rx={corner > 0.5 ? corner : undefined}
        {...paint}
      />
    )
  }
  /*
   * A linear mask is a half-plane, so there is no box to draw — just the line,
   * and for the veil a rectangle stretching away from it far enough to cover
   * any rotation of the frame.
   */
  const reach = Math.hypot(frame.width, frame.height)
  if (fill) return <rect x={-reach} y={-reach} width={reach * 2} height={reach} {...paint} />
  return <line x1={-reach} y1={0} x2={reach} y2={0} {...paint} />
}

function Handle({
  x,
  y,
  dx,
  dy,
  angle,
  onDown,
  cursor,
  ring
}: {
  x: number
  y: number
  dx: number
  dy: number
  angle: number
  onDown: (e: ReactPointerEvent) => void
  cursor: string
  ring?: boolean
}): ReactNode {
  // The handle sits on the shape's rotated axis, which is where the eye expects
  // to find it once the mask has been turned.
  const radians = (angle * Math.PI) / 180
  const left = x + dx * Math.cos(radians) - dy * Math.sin(radians)
  const top = y + dx * Math.sin(radians) + dy * Math.cos(radians)
  return (
    <span
      onPointerDown={onDown}
      style={{ left, top, cursor }}
      className={`pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 border border-ink-950/60 bg-ink-50 ${
        ring ? 'rounded-full' : 'rounded-[2px]'
      }`}
    />
  )
}

/** How far a point lies along one of the shape's own axes. */
function along(dx: number, dy: number, radians: number, axis: 'x' | 'y'): number {
  return axis === 'x'
    ? dx * Math.cos(radians) + dy * Math.sin(radians)
    : -dx * Math.sin(radians) + dy * Math.cos(radians)
}

function angleAt(px: number, py: number, cx: number, cy: number): number {
  return (Math.atan2(py - cy, px - cx) * 180) / Math.PI
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}
