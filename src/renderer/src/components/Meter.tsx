import { useEffect, useRef, type ReactNode } from 'react'
import {
  METER_SILENT,
  isClipping,
  meterFraction,
  meterStep,
  type MeterState
} from '@shared/render/meter'
import { readLevels } from '../levels'

/**
 * A level meter: a bar, a peak-hold tick, and red when it is about to clip.
 *
 * Runs its own animation loop and writes styles straight onto its elements, so
 * a dozen of them cost no React renders at all — see levels.ts. The ballistics
 * (instant attack, steady fall, held peak) are `meterStep`, in the shared layer,
 * where they are tested.
 */
export function Meter({
  source,
  width = 44,
  height = 4,
  title
}: {
  /** 'master', or a track id. */
  source: string
  width?: number
  height?: number
  title?: string
}): ReactNode {
  const bar = useRef<HTMLDivElement | null>(null)
  const hold = useRef<HTMLDivElement | null>(null)
  const state = useRef<MeterState>(METER_SILENT)

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const levels = readLevels(now)
      const peak = source === 'master' ? levels.master : (levels.tracks[source] ?? 0)
      state.current = meterStep(state.current, peak, now, now - last)
      last = now

      const { level, hold: held } = state.current
      if (bar.current) {
        bar.current.style.width = `${meterFraction(level) * 100}%`
        /*
         * Green, amber, red — by where the PEAK is, not the bar. The bar falls
         * back within a frame or two; a clip that turned the meter red for one
         * frame would be missed, which is why the hold marker carries it.
         */
        bar.current.style.backgroundColor = isClipping(level)
          ? 'rgb(239 68 68)'
          : level > -12
            ? 'rgb(245 158 11)'
            : 'rgb(52 211 153)'
      }
      if (hold.current) {
        hold.current.style.left = `calc(${meterFraction(held) * 100}% - 1px)`
        hold.current.style.opacity = held > -59 ? '1' : '0'
        hold.current.style.backgroundColor = isClipping(held) ? 'rgb(239 68 68)' : 'rgb(226 232 240)'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [source])

  return (
    <div
      title={title ?? 'Peak level — red within 1 dB of full scale'}
      className="relative shrink-0 overflow-hidden rounded-[1px] bg-ink-800"
      style={{ width, height }}
    >
      <div ref={bar} className="absolute inset-y-0 left-0" style={{ width: 0 }} />
      <div ref={hold} className="absolute inset-y-0 w-[2px]" style={{ opacity: 0 }} />
    </div>
  )
}
