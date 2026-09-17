import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { Clip, MediaAsset } from '@shared/timeline'
import { framesToSeconds, secondsToFrames } from '@shared/timeline'
import { useEditor } from '../store'

/**
 * Pick which part of the song the reel is built from.
 *
 * This exists because the first real run of the reel laid a four-minute edit
 * out of a thirty-second intention: the song went straight onto the timeline at
 * full length and nothing in the automation panel said how long it was, let
 * alone let you shorten it. The range is not separate state — it IS the music
 * clip's trim, so what you set here is what the timeline and the render agree
 * on, and dragging the clip's edges in the timeline moves these handles too.
 */

interface Peaks {
  values: number[]
  buckets: number
  durationMs: number
}

const peakCache = new Map<string, Peaks>()

type Handle = 'in' | 'out' | null

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function MusicRange({ clip, asset }: { clip: Clip; asset: MediaAsset }): ReactNode {
  const setSourceRange = useEditor((s) => s.setSourceRange)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)
  const fps = useEditor((s) => s.project.settings.fps)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState<Handle>(null)

  /* A callback ref, not an effect: the box does not exist until peaks load, and
     an effect with [] deps would observe the null this ref held on mount. */
  const attachBox = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    boxRef.current = element
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    observerRef.current = observer
    const rect = element.getBoundingClientRect()
    setBox({ width: rect.width, height: rect.height })
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  useEffect(() => {
    const cached = peakCache.get(asset.path)
    if (cached) {
      setPeaks(cached)
      return
    }
    let cancelled = false
    setLoading(true)
    void window.forge
      .peaks(asset.path, 400)
      .then((result) => {
        if (cancelled) return
        peakCache.set(asset.path, result)
        setPeaks(result)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [asset.path])

  const total = Math.max(1, asset.durationFrames)
  const inPercent = (clip.inPoint / total) * 100
  const outPercent = ((clip.inPoint + clip.duration) / total) * 100

  /* ---------------------------------------------------------------- draw */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || box.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(box.width * dpr)
    canvas.height = Math.round(box.height * dpr)
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, box.width, box.height)
    if (!peaks || peaks.buckets === 0) return

    const mid = box.height / 2
    const step = box.width / peaks.buckets
    const inX = (inPercent / 100) * box.width
    const outX = (outPercent / 100) * box.width

    const bars = (fill: string): void => {
      ctx.fillStyle = fill
      for (let i = 0; i < peaks.buckets; i++) {
        const min = peaks.values[i * 2]
        const max = peaks.values[i * 2 + 1]
        ctx.fillRect(
          i * step,
          mid - max * mid * 0.9,
          Math.max(1, step),
          Math.max(1, (max - min) * mid * 0.9)
        )
      }
    }

    bars('#2f3947')
    ctx.save()
    ctx.beginPath()
    ctx.rect(inX, 0, Math.max(0, outX - inX), box.height)
    ctx.clip()
    bars('#f97341')
    ctx.restore()
  }, [peaks, box, inPercent, outPercent])

  /* -------------------------------------------------------------- drag */

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: PointerEvent): void => {
      const rect = boxRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const frame = Math.round(ratio * total)
      const out = clip.inPoint + clip.duration
      // A one-frame music bed is not a useful thing to be able to drag to.
      const minimum = secondsToFrames(1, fps)
      if (dragging === 'in') setSourceRange(clip.id, Math.min(frame, out - minimum), out)
      else setSourceRange(clip.id, clip.inPoint, Math.max(frame, clip.inPoint + minimum))
    }

    const onUp = (): void => {
      setDragging(null)
      commit()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, clip, total, fps, setSourceRange, commit])

  const selectedSeconds = framesToSeconds(clip.duration, fps)
  const fullSeconds = framesToSeconds(total, fps)
  const trimmed = clip.duration < total - 2

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10.5px] text-ink-300">{asset.name}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-500">
          <span className={trimmed ? 'text-flame-400' : 'text-ink-300'}>
            {formatSeconds(selectedSeconds)}
          </span>
          <span className="text-ink-600"> / {formatSeconds(fullSeconds)}</span>
        </span>
      </div>

      <div ref={attachBox} className="relative h-12 rounded bg-ink-950/60">
        <canvas ref={canvasRef} className="absolute inset-0" />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[10px] text-ink-600">
            <Loader2 size={11} className="animate-spin" /> reading audio
          </div>
        )}

        {!loading &&
          (['in', 'out'] as const).map((handle) => (
            <div
              key={handle}
              onPointerDown={(e) => {
                e.preventDefault()
                begin()
                setDragging(handle)
              }}
              title={handle === 'in' ? 'Drag where the reel starts' : 'Drag where the reel ends'}
              className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${handle === 'in' ? inPercent : outPercent}%` }}
            >
              <div className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-flame-300" />
              <div className="absolute left-1/2 top-1/2 h-6 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-ink-950 bg-flame-300" />
            </div>
          ))}
      </div>

      <div className="flex items-center gap-2">
        <p className="flex-1 text-[10px] leading-snug text-ink-600">
          {trimmed
            ? 'The reel covers the highlighted part only.'
            : 'Drag the handles to use a section instead of the whole track.'}
        </p>
        {trimmed && (
          <button
            onClick={() => {
              begin()
              setSourceRange(clip.id, 0, total)
              commit()
            }}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-500 hover:bg-ink-800 hover:text-ink-200"
          >
            Use all
          </button>
        )}
      </div>
    </div>
  )
}
