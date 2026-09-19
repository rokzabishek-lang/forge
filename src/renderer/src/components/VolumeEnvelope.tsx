import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { normaliseKeys, valueAt, type Keyframe } from '@shared/render/keyframes'
import { useEditor } from '../store'

/**
 * The volume line, drawn on the clip itself.
 *
 * The same shape a DAW gives you: grab the line, drag a point, and the sound
 * follows. It is deliberately ON the clip rather than in a panel, because the
 * gesture is "quiet it HERE" — and a panel two columns away cannot say where
 * here is. A DJ dropping a clip into a set reaches for the line, not a menu.
 *
 * The points are ordinary `volume` keyframes, the same ones the inspector's
 * curve editor writes and the same ones the render compiles into a
 * `volume=…:eval=frame` expression. Nothing here is a second source of truth.
 */

/** A point's grab radius, and how far the line sits inside the clip. */
const DOT = 7
const PADDING = 4

/** How far either side of the line counts as grabbing it, in pixels. */
const REACH = 5

export function VolumeEnvelope({
  clip,
  zoom,
  height
}: {
  clip: Clip
  /** Pixels per frame, so the line follows the timeline's scale. */
  zoom: number
  height: number
}): ReactNode {
  const setKeyframes = useEditor((s) => s.setKeyframes)
  const select = useEditor((s) => s.select)
  const dragging = useRef<number | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const keys = normaliseKeys(clip.keyframes?.volume ?? [], clip.duration)
  const flat = clip.volume ?? 1

  const usable = Math.max(1, height - PADDING * 2)
  /** A level, 0 at the bottom of the lane and 1 at the top. */
  const yOf = (value: number): number => PADDING + (1 - Math.max(0, Math.min(1, value))) * usable
  /** Where in the clip, and how loud, a pointer is. */
  const at = useCallback(
    (event: { clientX: number; clientY: number }): { frame: number; value: number } | null => {
      const box = boxRef.current?.getBoundingClientRect()
      if (!box) return null
      return {
        frame: Math.max(0, Math.min(clip.duration, Math.round((event.clientX - box.left) / zoom))),
        value: Math.max(0, Math.min(1, 1 - (event.clientY - box.top - PADDING) / usable))
      }
    },
    [clip.duration, zoom, usable]
  )

  const commit = (next: Keyframe[]): void => setKeyframes(clip.id, 'volume', next)

  /**
   * Dragging a point moves it in BOTH axes.
   *
   * Time as well as level, because "make it quiet a moment earlier" is the
   * commonest correction and re-drawing the point is a poor way to ask for it.
   */
  const grab = (index: number) => (event: ReactPointerEvent): void => {
    // The clip underneath is draggable; without this, touching the line slides
    // the whole clip down the timeline instead.
    event.stopPropagation()
    event.preventDefault()
    dragging.current = index
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)

    const move = (ev: PointerEvent): void => {
      const point = at(ev)
      if (point === null || dragging.current === null) return
      const next = keys.map((k, i) =>
        i === dragging.current ? { ...k, frame: point.frame, value: point.value } : k
      )
      commit(next)
    }
    const up = (): void => {
      dragging.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * A click ON THE LINE adds a point there.
   *
   * On the line, not anywhere on the clip. The first version of this took the
   * whole clip body — and since it stops propagation, that quietly made every
   * clip with sound in it immovable: no dragging along the timeline, no
   * dragging to another track, no trimming, not even selecting. One control
   * ate every other gesture the clip had.
   *
   * The first point on an un-drawn clip starts from the clip's flat level
   * rather than from wherever the pointer landed vertically — otherwise the
   * first touch silently changes the volume of the whole clip, which is not
   * what "add a point" should mean.
   */
  const addPoint = (event: ReactPointerEvent): void => {
    event.stopPropagation()
    const point = at(event)
    if (!point) return
    // Touching a clip selects it everywhere else in the editor; the line is
    // not an exception just because it also does something.
    select(clip.id)
    const value = keys.length === 0 ? flat : point.value
    commit([...keys, { frame: point.frame, value, ease: 'linear' }])
  }

  const removePoint = (index: number) => (event: { stopPropagation: () => void; preventDefault: () => void }): void => {
    event.stopPropagation()
    event.preventDefault()
    commit(keys.filter((_, i) => i !== index))
  }

  const width = Math.max(1, clip.duration * zoom)
  /*
   * With no points the line is flat at the clip's own level, so the control is
   * visible before it has been used. A lane that shows nothing until you find
   * the right invisible place to click is a lane nobody finds.
   */
  const path =
    keys.length === 0
      ? `M 0 ${yOf(flat)} L ${width} ${yOf(flat)}`
      : [
          `M 0 ${yOf(valueAt(keys, 0, clip.duration, flat))}`,
          ...keys.map((k) => `L ${k.frame * zoom} ${yOf(k.value)}`),
          `L ${width} ${yOf(valueAt(keys, clip.duration, clip.duration, flat))}`
        ].join(' ')

  /*
   * The container passes pointers straight through, and only the line and its
   * points take them back. That is what keeps the clip underneath draggable.
   */
  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 z-10">
      <svg
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0 overflow-visible"
      >
        {/*
          An invisible fat copy of the line, purely to be hit. `stroke` hit
          testing follows the stroke geometry rather than what it is painted
          with, so a transparent one ten pixels wide is a grabbable line
          without being a visible one.
        */}
        <path
          d={path}
          fill="none"
          stroke="rgba(0,0,0,0)"
          strokeWidth={REACH * 2}
          style={{ pointerEvents: 'stroke', cursor: 'crosshair' }}
          onPointerDown={addPoint}
        >
          <title>Click the line to add a point · drag a point to shape it · double-click to remove</title>
        </path>
        <path
          d={path}
          fill="none"
          stroke="rgb(245,154,117)"
          strokeWidth={1.5}
          className="pointer-events-none"
        />
      </svg>
      {keys.map((key, index) => (
        <span
          key={`${key.frame}-${index}`}
          onPointerDown={grab(index)}
          onDoubleClick={removePoint(index)}
          className="pointer-events-auto absolute rounded-full border border-ink-950 bg-flame-400 hover:bg-flame-300"
          style={{
            width: DOT,
            height: DOT,
            left: key.frame * zoom - DOT / 2,
            top: yOf(key.value) - DOT / 2,
            cursor: 'grab'
          }}
        />
      ))}
    </div>
  )
}
