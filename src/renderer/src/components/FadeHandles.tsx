import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { clipFades } from '@shared/render/audioFade'
import { useEditor } from '../store'

/**
 * Fade handles, at the top corners of the clip.
 *
 * The gesture every editor uses: grab the corner, pull it inwards, the sound
 * ramps over the distance you pulled. It is on the clip rather than in a panel
 * for the same reason the volume line is — "don't start so abruptly" is a
 * statement about a place, and a panel two columns away cannot say where.
 *
 * Distinct from the volume envelope drawn underneath it. That one is *quiet it
 * HERE*; this one is *don't start or stop abruptly*, and they multiply. A DAW
 * keeps them apart so softening an entry does not mean redrawing a curve you
 * already shaped.
 */

/** The grab square, and how much of the ramp is drawn. */
const GRIP = 11

export function FadeHandles({
  clip,
  zoom,
  height,
  selected
}: {
  clip: Clip
  /** Pixels per frame. */
  zoom: number
  height: number
  selected: boolean
}): ReactNode {
  const setFade = useEditor((s) => s.setFade)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const fades = clipFades(clip)
  const width = Math.max(1, clip.duration * zoom)

  const drag = (edge: 'in' | 'out') => (event: ReactPointerEvent): void => {
    /*
     * Load-bearing. The clip underneath drags, and the trim strip this sits on
     * top of trims — without stopping here, grabbing a fade slides the whole
     * clip down the timeline instead.
     */
    event.stopPropagation()
    event.preventDefault()
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    begin()

    const move = (ev: PointerEvent): void => {
      const x = ev.clientX - box.left
      const frames = edge === 'in' ? x / zoom : (width - x) / zoom
      setFade(clip.id, edge, frames)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      commit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const clear =
    (edge: 'in' | 'out') =>
    (event: { stopPropagation: () => void; preventDefault: () => void }): void => {
      event.stopPropagation()
      event.preventDefault()
      begin()
      setFade(clip.id, edge, 0)
      commit()
    }

  const inX = fades.in * zoom
  const outX = width - fades.out * zoom

  /*
   * The ramps are always drawn; only the grips appear on hover.
   *
   * A fade that exists must be visible without hunting for it — otherwise the
   * clip looks identical whether or not it fades, and the only way to find out
   * is to play it. The grips are the opposite: a grip on every clip at all
   * times is clutter on a busy timeline, and worse, an always-live target
   * eleven pixels into the trim strip would quietly take a slice of trimming
   * away from clips nobody is fading.
   */
  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 z-30">
      <svg
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0"
        aria-hidden
      >
        {fades.in > 0 && (
          <path
            d={`M 0 ${height} L ${inX} 0 L 0 0 Z`}
            fill="rgba(10,12,15,0.55)"
            stroke="rgb(245,154,117)"
            strokeWidth={1}
          />
        )}
        {fades.out > 0 && (
          <path
            d={`M ${width} ${height} L ${outX} 0 L ${width} 0 Z`}
            fill="rgba(10,12,15,0.55)"
            stroke="rgb(245,154,117)"
            strokeWidth={1}
          />
        )}
      </svg>

      {(['in', 'out'] as const).map((edge) => {
        const x = edge === 'in' ? inX : outX
        return (
          <span
            key={edge}
            onPointerDown={drag(edge)}
            onDoubleClick={clear(edge)}
            title={
              edge === 'in'
                ? 'Drag in to fade the sound up · double-click to remove'
                : 'Drag in to fade the sound down · double-click to remove'
            }
            className={`absolute rounded-sm border border-ink-950 bg-flame-400 transition-opacity hover:bg-flame-300 ${
              selected
                ? 'pointer-events-auto opacity-100'
                : 'pointer-events-none opacity-0 group-hover/clip:pointer-events-auto group-hover/clip:opacity-100'
            }`}
            style={{
              width: GRIP,
              height: GRIP,
              left: Math.max(0, Math.min(width - GRIP, x - GRIP / 2)),
              top: 0,
              cursor: 'ew-resize'
            }}
          />
        )
      })}
    </div>
  )
}
