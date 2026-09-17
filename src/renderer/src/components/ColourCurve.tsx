import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  CHANNEL_LABEL,
  CURVE_CHANNELS,
  IDENTITY,
  curveAt,
  isIdentityCurve,
  normaliseCurve,
  type CurveChannel,
  type CurvePoint,
  type Curves
} from '@shared/render/colourCurve'

/**
 * The grading curve.
 *
 * Input along the bottom, output up the side, with the diagonal drawn as the
 * do-nothing reference — the shape every colourist reads at a glance. Above the
 * line is brighter, below is darker, and an S is contrast.
 *
 * The line follows the natural cubic spline ffmpeg actually uses, not straight
 * segments between the points. Drawing it straight would show a shape the export
 * does not produce, and the overshoot in a spline IS the look.
 */

const SIZE = 150
/** Grab radius in pixels for picking up an existing point. */
const GRAB = 10

export function ColourCurve({
  curves,
  onChange
}: {
  curves: Curves | undefined
  onChange: (curves: Curves) => void
}): ReactNode {
  const [channel, setChannel] = useState<CurveChannel>('master')
  const boxRef = useRef<HTMLDivElement | null>(null)

  const points = normaliseCurve(curves?.[channel] ?? IDENTITY)
  const write = (next: CurvePoint[]): void =>
    onChange({ ...curves, [channel]: normaliseCurve(next) })

  const toPx = (p: CurvePoint): { x: number; y: number } => ({
    x: p.x * SIZE,
    // Output up the side: zero at the bottom, which is how every curve editor
    // in every grading tool draws it.
    y: SIZE - p.y * SIZE
  })

  const fromEvent = (e: { clientX: number; clientY: number }): CurvePoint | null => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box || box.width < 1) return null
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, 1 - (e.clientY - box.top) / box.height))
    }
  }

  const startDrag = (index: number) => (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const isEnd = index === 0 || index === points.length - 1
    const move = (ev: PointerEvent): void => {
      const at = fromEvent(ev)
      if (!at) return
      const next = points.map((p, i) =>
        i === index
          ? // The end points stay pinned to their edge: a curve that starts at
            // x=0.3 silently crushes everything below it.
            { x: isEnd ? p.x : at.x, y: at.y }
          : p
      )
      write(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const addPoint = (e: ReactPointerEvent): void => {
    const at = fromEvent(e)
    if (!at) return
    // Near an existing point, this was a miss rather than a request for another.
    const near = points.some((p) => Math.abs(toPx(p).x - at.x * SIZE) < GRAB)
    if (near) return
    write([...points, at])
  }

  const path = Array.from({ length: SIZE + 1 }, (_, i) => {
    const x = i / SIZE
    return `${(x * SIZE).toFixed(1)},${(SIZE - curveAt(points, x) * SIZE).toFixed(1)}`
  }).join(' ')

  const touched = CURVE_CHANNELS.filter((c) => !isIdentityCurve(curves?.[c]))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-0.5">
        {CURVE_CHANNELS.map((key) => (
          <button
            key={key}
            onClick={() => setChannel(key)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              channel === key
                ? 'bg-ink-800 text-ink-200'
                : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
            }`}
          >
            <span style={{ color: channel === key ? undefined : dotFor(key) }}>
              {CHANNEL_LABEL[key]}
            </span>
            {!isIdentityCurve(curves?.[key]) && (
              <span className="ml-1" style={{ color: dotFor(key) }}>
                •
              </span>
            )}
          </button>
        ))}
        {touched.length > 0 && (
          <button
            onClick={() => onChange({})}
            title="Back to a straight line on every channel"
            className="ml-auto rounded px-1 py-0.5 text-[9.5px] text-ink-600 hover:bg-ink-800 hover:text-ink-300"
          >
            reset
          </button>
        )}
      </div>

      <div
        ref={boxRef}
        onPointerDown={addPoint}
        style={{ width: SIZE, height: SIZE }}
        className="relative cursor-copy rounded border border-ink-800 bg-ink-950"
      >
        <svg width={SIZE} height={SIZE} className="absolute inset-0">
          {/* Quarters, so the eye can judge where a point sits. */}
          {[0.25, 0.5, 0.75].map((t) => (
            <g key={t} stroke="rgba(255,255,255,0.06)">
              <line x1={t * SIZE} x2={t * SIZE} y1={0} y2={SIZE} />
              <line x1={0} x2={SIZE} y1={t * SIZE} y2={t * SIZE} />
            </g>
          ))}
          {/* Do nothing, for reference. */}
          <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="rgba(255,255,255,0.16)" strokeDasharray="3 3" />
          <polyline points={path} fill="none" stroke={dotFor(channel)} strokeWidth={1.5} />
        </svg>

        {points.map((point, index) => {
          const at = toPx(point)
          return (
            <span
              key={index}
              onPointerDown={startDrag(index)}
              onDoubleClick={() => {
                if (index === 0 || index === points.length - 1) return
                write(points.filter((_, i) => i !== index))
              }}
              title={`in ${point.x.toFixed(2)} → out ${point.y.toFixed(2)}`}
              style={{ left: at.x, top: at.y, background: dotFor(channel) }}
              className="absolute size-2 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full ring-1 ring-ink-950"
            />
          )
        })}
      </div>

      <p className="text-[9.5px] leading-snug text-ink-600">
        Click to add, drag to shape, double-click a middle point to remove it. Above the dashes
        is brighter; an S is contrast.
      </p>
    </div>
  )
}

/** One colour per channel, so which curve you are on never needs reading. */
function dotFor(channel: CurveChannel): string {
  switch (channel) {
    case 'r':
      return '#f2635f'
    case 'g':
      return '#5fd08a'
    case 'b':
      return '#5f9bf2'
    default:
      return '#e9e9ec'
  }
}
