import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  PROPERTY_INFO,
  axisPosition,
  formatKeyed,
  graphWindow,
  normaliseKeys,
  valueAt,
  valueAtAxis,
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
/**
 * Room round the plot, in pixels.
 *
 * A key at the clip's first frame, or at the top or bottom of the window, sat
 * ON the edge of the box, and the box clips: half the point was cut away and
 * the half that was left was a sliver to aim at. Inset by more than a point's
 * half-width, every key is whole and grabbable.
 */
const PAD = 7
/** Below this a press is a click on a point, above it a deliberate drag. */
const GRAB_RADIUS = 9

export function CurveEditor({
  property,
  keys,
  durationFrames,
  playheadFrame,
  onChange,
  onScrub,
  rest
}: {
  property: KeyedProperty
  /**
   * The value with no keys — the property's neutral unless the caller knows
   * better. A mask track rests at the mask's own shape, not at a constant.
   */
  rest?: number
  keys: Keyframe[]
  durationFrames: number
  /** Frames from the clip's start; outside the clip it is simply not drawn. */
  playheadFrame: number
  onChange: (keys: Keyframe[]) => void
  onScrub: (frame: number) => void
}): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null)
  /*
   * The box's real width, kept current.
   *
   * Read off the ref during render it was 240 on the first paint and then
   * whatever the box was when something else happened to re-render — so the
   * drawing's coordinates and the pointer's could disagree after a resize.
   */
  const [width, setWidth] = useState(240)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(() => setWidth(Math.max(1, box.clientWidth)))
    observer.observe(box)
    setWidth(Math.max(1, box.clientWidth))
    return () => observer.disconnect()
  }, [])
  /*
   * The window, held still while a point is dragged or a line drawn.
   *
   * It is fitted to the keys (graphWindow), so it would otherwise refit under
   * the pointer on every move and the point would run away from the hand.
   * It settles to the new keys when the button comes up.
   */
  const [frozen, setFrozen] = useState<{ lo: number; hi: number } | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [pencil, setPencil] = useState(false)
  /** The stroke in progress, so the line follows the hand at screen rate. */
  const strokeRef = useRef<Sample[]>([])
  const [stroke, setStrokeView] = useState<Sample[] | null>(null)

  const info = PROPERTY_INFO[property]
  const span = Math.max(1, durationFrames)
  const points = normaliseKeys(keys, durationFrames)
  const resting = rest ?? info.neutral
  const view = frozen ?? graphWindow(property, points, resting)
  const viewSpan = Math.max(1e-6, view.hi - view.lo)
  const plotW = Math.max(1, width - 2 * PAD)
  const plotH = HEIGHT - 2 * PAD

  /*
   * Heights come from the property's own scale — volume on the fader's dB
   * curve — so a level is at the same height here as on the clip; zoom and
   * rotation show the window of it their keys are in.
   */
  const toX = (frame: number): number => PAD + (frame / span) * plotW
  const toY = (value: number): number =>
    PAD + (1 - (axisPosition(property, value) - view.lo) / viewSpan) * plotH

  /**
   * The frame and value under the pointer.
   *
   * Height is NOT clamped to the box: a point dragged up past the top keeps
   * rising, and the window refits round it when it is let go. Clamping would
   * pin every drag to the window it started in.
   */
  const fromEvent = (e: { clientX: number; clientY: number }): Sample | null => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box || box.width < 1) return null
    const frame = ((e.clientX - box.left - PAD) / Math.max(1, box.width - 2 * PAD)) * span
    const height = 1 - (e.clientY - box.top - PAD) / Math.max(1, box.height - 2 * PAD)
    return {
      frame: Math.max(0, Math.min(span, frame)),
      value: valueAtAxis(property, view.lo + height * viewSpan)
    }
  }

  /**
   * A stroke's keys, simplified in the space it was DRAWN in.
   *
   * On a dB axis, a bend near the bottom is a few thousandths of gain; judged
   * in gain it would be dropped as noise, although it is plainly on screen.
   */
  const fromStroke = (samples: Sample[]): Keyframe[] =>
    keysFromStroke(
      samples.map((s) => ({ ...s, value: axisPosition(property, s.value) })),
      durationFrames,
      1
    ).map((k) => ({ ...k, value: valueAtAxis(property, k.value) }))

  /** The curve as a polyline, sampled densely enough to show the easing. */
  const outline = (): string => {
    const steps = Math.max(24, Math.min(160, Math.round(plotW)))
    const shown = stroke ? fromStroke(stroke) : points
    return Array.from({ length: steps + 1 }, (_, i) => {
      const frame = (i / steps) * span
      return `${toX(frame).toFixed(1)},${toY(
        valueAt(shown, frame, durationFrames, resting)
      ).toFixed(1)}`
    }).join(' ')
  }

  const startDraw = (e: ReactPointerEvent): void => {
    const first = fromEvent(e)
    if (!first) return
    e.preventDefault()
    setFrozen(view)
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
      setFrozen(null)
      const drawn = strokeRef.current
      setStrokeView(null)
      strokeRef.current = []
      // A tap is not a stroke — it would collapse the whole curve to one value.
      if (drawn.length >= 3) onChange(fromStroke(drawn))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const startDragPoint = (index: number) => (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setFrozen(view)
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
      setFrozen(null)
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
    const near = points.some((k) => Math.abs(toX(k.frame) - toX(sample.frame)) < GRAB_RADIUS)
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
            x1={PAD}
            x2={width - PAD}
            y1={toY(resting)}
            y2={toY(resting)}
            stroke="rgba(255,255,255,0.10)"
            strokeDasharray="3 3"
          />
          <polyline
            points={outline()}
            fill="none"
            stroke={drawing ? 'rgb(249,115,65)' : 'rgba(249,115,65,0.85)'}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          {playheadInside && (
            <line
              x1={toX(playheadFrame)}
              x2={toX(playheadFrame)}
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
              title={`Frame ${key.frame} · ${formatKeyed(property, key.value)} — drag to move, double-click to remove`}
              style={{
                left: toX(key.frame),
                top: toY(key.value),
                transform: 'translate(-50%, -50%) rotate(45deg)'
              }}
              className="absolute h-2.5 w-2.5 cursor-move rounded-[1px] border border-flame-300 bg-flame-500"
            />
          ))}
      </div>

      {/*
        Time along the bottom, and what the graph's height spans in the middle.
        The two ends used to read "1.00× · start" and "4.00× · end" — the axis
        limits, printed where they looked like the values at the clip's start
        and end.
      */}
      <div className="flex justify-between gap-2 px-[7px] text-[9px] text-ink-700">
        <span>clip start</span>
        <span className="text-ink-600" title="The height of the graph runs from the bottom value to the top one">
          {formatKeyed(property, valueAtAxis(property, view.lo))} –{' '}
          {formatKeyed(property, valueAtAxis(property, view.hi))}
        </span>
        <span>clip end</span>
      </div>
    </div>
  )
}
