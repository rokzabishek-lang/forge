import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  PROPERTY_INFO,
  normaliseKeys,
  valueAt,
  type KeyedProperty,
  type Keyframe
} from '@shared/render/keyframes'
import { keysFromStroke, type Sample } from '@shared/render/curve'

/**
 * The curve, drawn and draggable.
 *
 * Two ways to say the same thing. Dragging a point is precise; drawing the shape
 * is faster and is how you say "fast in, slow out, then hold" without knowing
 * that is what you mean. A freehand line is hundreds of samples, so it is
 * reduced to the handful of points that carry its shape — see render/curve.
 *
 * Time runs left to right across the clip; the property runs bottom to top over
 * its own range. The playhead is drawn where it actually is, because a curve you
 * cannot line up against the picture is a graph rather than an editing tool.
 */

const HEIGHT = 74
/** Below this a press is a click on a point, above it a deliberate drag. */
const GRAB_RADIUS = 9

export function CurveEditor({
  property,
  keys,
  durationFrames,
  playheadFrame,
  onChange,
  onScrub
}: {
  property: KeyedProperty
  keys: Keyframe[]
  durationFrames: number
  /** Frames from the clip's start; outside the clip it is simply not drawn. */
  playheadFrame: number
  onChange: (keys: Keyframe[]) => void
  onScrub: (frame: number) => void
}): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [pencil, setPencil] = useState(false)
  /** The stroke in progress, so the line follows the hand at screen rate. */
  const strokeRef = useRef<Sample[]>([])
  const [stroke, setStrokeView] = useState<Sample[] | null>(null)

  const info = PROPERTY_INFO[property]
  const span = Math.max(1, durationFrames)
  const range = info.max - info.min || 1
  const points = normaliseKeys(keys, durationFrames)

  const toX = (frame: number, width: number): number => (frame / span) * width
  const toY = (value: number): number =>
    HEIGHT - ((value - info.min) / range) * HEIGHT

  const fromEvent = (e: { clientX: number; clientY: number }): Sample | null => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box || box.width < 1) return null
    const frame = ((e.clientX - box.left) / box.width) * span
    const value = info.min + (1 - (e.clientY - box.top) / box.height) * range
    return {
      frame: Math.max(0, Math.min(span, frame)),
      value: Math.max(info.min, Math.min(info.max, value))
    }
  }

  /** The curve as a polyline, sampled densely enough to show the easing. */
  const outline = (width: number): string => {
    const steps = Math.max(24, Math.min(160, Math.round(width)))
    const shown = stroke ? keysFromStroke(stroke, durationFrames, range) : points
    return Array.from({ length: steps + 1 }, (_, i) => {
      const frame = (i / steps) * span
      return `${toX(frame, width).toFixed(1)},${toY(
        valueAt(shown, frame, durationFrames, info.neutral)
      ).toFixed(1)}`
    }).join(' ')
  }

  const width = boxRef.current?.clientWidth ?? 240

  const startDraw = (e: ReactPointerEvent): void => {
    const first = fromEvent(e)
    if (!first) return
    e.preventDefault()
    setDrawing(true)
    strokeRef.current = [first]
    setStrokeView([first])

    const move = (ev: PointerEvent): void => {
      const sample = fromEvent(ev)
      if (!sample) return
      strokeRef.current.push(sample)
      setStrokeView([...strokeRef.current])
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setDrawing(false)
      const drawn = strokeRef.current
      setStrokeView(null)
      strokeRef.current = []
      // A tap is not a stroke — it would collapse the whole curve to one value.
      if (drawn.length >= 3) onChange(keysFromStroke(drawn, durationFrames, range))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const startDragPoint = (index: number) => (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const move = (ev: PointerEvent): void => {
      const sample = fromEvent(ev)
      if (!sample) return
      const next = points.map((k, i) =>
        i === index ? { ...k, frame: Math.round(sample.frame), value: sample.value } : k
      )
      onChange(normaliseKeys(next, durationFrames))
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

  /** Click on empty graph: add a key there, or move the playhead. */
  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (pencil) {
      startDraw(e)
      return
    }
    const sample = fromEvent(e)
    if (!sample) return
    const near = points.some(
      (k) => Math.abs(toX(k.frame, width) - toX(sample.frame, width)) < GRAB_RADIUS
    )
    if (near) {
      onScrub(Math.round(sample.frame))
      return
    }
    onChange(
      normaliseKeys(
        [...points, { frame: Math.round(sample.frame), value: sample.value, ease: 'smooth' }],
        durationFrames
      )
    )
  }

  const playheadInside = playheadFrame >= 0 && playheadFrame <= span

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setPencil((on) => !on)}
          title={
            pencil
              ? 'Drawing: drag to sketch the whole curve'
              : 'Draw the curve by hand instead of placing points'
          }
          className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            pencil
              ? 'bg-flame-500 text-ink-950'
              : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
          }`}
        >
          ✎ Draw
        </button>
        <span className="truncate text-[9.5px] text-ink-600">
          {pencil ? 'drag to sketch' : 'click to add'}
        </span>
        {points.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="ml-auto rounded px-1 py-0.5 text-[9.5px] text-ink-600 hover:bg-ink-800 hover:text-ink-300"
          >
            clear
          </button>
        )}
      </div>

      <div
        ref={boxRef}
        onPointerDown={onBackgroundDown}
        style={{ height: HEIGHT }}
        className={`relative w-full overflow-hidden rounded border bg-ink-950 ${
          drawing ? 'border-flame-500' : 'border-ink-800'
        } ${pencil ? 'cursor-crosshair' : 'cursor-copy'}`}
      >
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0"
        >
          {/* The neutral value, so "no change" is visible rather than implied. */}
          <line
            x1={0}
            x2={width}
            y1={toY(info.neutral)}
            y2={toY(info.neutral)}
            stroke="rgba(255,255,255,0.10)"
            strokeDasharray="3 3"
          />
          <polyline
            points={outline(width)}
            fill="none"
            stroke={drawing ? 'rgb(249,115,65)' : 'rgba(249,115,65,0.85)'}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          {playheadInside && (
            <line
              x1={toX(playheadFrame, width)}
              x2={toX(playheadFrame, width)}
              y1={0}
              y2={HEIGHT}
              stroke="rgba(255,255,255,0.45)"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* Points last, so they sit above the line and can be grabbed. */}
        {!drawing &&
          points.map((key, index) => (
            <span
              key={`${key.frame}-${index}`}
              onPointerDown={startDragPoint(index)}
              onDoubleClick={() =>
                onChange(points.filter((_, i) => i !== index))
              }
              title={`Frame ${key.frame} · ${key.value.toFixed(2)} — drag to move, double-click to remove`}
              style={{
                left: `${(key.frame / span) * 100}%`,
                top: toY(key.value),
                transform: 'translate(-50%, -50%) rotate(45deg)'
              }}
              className="absolute h-2.5 w-2.5 cursor-move rounded-[1px] border border-flame-300 bg-flame-500"
            />
          ))}
      </div>

      <div className="flex justify-between text-[9px] text-ink-700">
        <span>
          {info.min}
          {info.suffix} · start
        </span>
        <span>
          {info.max}
          {info.suffix} · end
        </span>
      </div>
    </div>
  )
}
