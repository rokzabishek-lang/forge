import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { Clip, MediaAsset } from '@shared/timeline'
import { formatTimecode } from '@shared/timeline'
import { useEditor } from '../store'

interface Peaks {
  values: number[]
  buckets: number
  durationMs: number
}

/** Peaks are keyed by path so switching clips back and forth is instant. */
const peakCache = new Map<string, Peaks>()

type Handle = 'in' | 'out' | null

/**
 * Waveform with draggable in and out points.
 *
 * Trims in SOURCE time — the clip keeps its position on the timeline and only
 * the portion of the file it shows changes. That is the right model for picking
 * a hit out of an SFX file or a bar out of a music track.
 */
export function Waveform(): ReactNode {
  const project = useEditor((s) => s.project)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const setSourceRange = useEditor((s) => s.setSourceRange)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)
  const playhead = useEditor((s) => s.playhead)
  const audition = useEditor((s) => s.audition)
  const setAuditionRange = useEditor((s) => s.setAuditionRange)
  const addAuditionToTimeline = useEditor((s) => s.addAuditionToTimeline)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<Handle>(null)

  const clip: Clip | null = project.clips.find((c) => c.id === selectedClipId) ?? null
  const asset: MediaAsset | null = clip
    ? project.assets.find((a) => a.id === clip.assetId) ?? null
    : null
  const fps = project.settings.fps

  // A library item being auditioned has no clip and no asset record — it is
  // just a file on disk, so the waveform works from the path directly.
  const sourcePath = asset?.path ?? (clip ? null : audition?.path ?? null)
  const sourceName = asset?.name ?? audition?.name ?? null
  const hasAudio = asset ? asset.hasAudio : Boolean(audition)

  /**
   * A callback ref, not an effect.
   *
   * This component returns an empty state before anything is selected, and that
   * state has no box to measure. An effect with [] deps observes whatever the
   * ref held on mount — null — and never re-attaches when the real element
   * appears, so the canvas stays 0x0 and nothing is ever drawn.
   */
  const attachBox = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    boxRef.current = element
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    observerRef.current = observer
    // Seed immediately: the observer's first callback can be a frame away, and
    // a single missed frame on a short audition looks like a blank panel.
    const rect = element.getBoundingClientRect()
    setBox({ width: rect.width, height: rect.height })
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  /* --------------------------------------------------------------- peaks */

  useEffect(() => {
    if (!sourcePath || !hasAudio) {
      setPeaks(null)
      setError(null)
      return
    }
    const cached = peakCache.get(sourcePath)
    if (cached) {
      setPeaks(cached)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    void window.forge
      .peaks(sourcePath, 900)
      .then((result) => {
        if (cancelled) return
        peakCache.set(sourcePath, result)
        setPeaks(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sourcePath, hasAudio])

  /* ---------------------------------------------------------------- draw */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || box.width === 0 || !sourcePath) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(box.width * dpr)
    canvas.height = Math.round(box.height * dpr)
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, box.width, box.height)

    const mid = box.height / 2
    const total = asset?.durationFrames ?? 1

    if (peaks && peaks.buckets > 0) {
      const step = box.width / peaks.buckets
      ctx.fillStyle = '#3a4552'
      for (let i = 0; i < peaks.buckets; i++) {
        const min = peaks.values[i * 2]
        const max = peaks.values[i * 2 + 1]
        const top = mid - max * mid * 0.92
        const height = Math.max(1, (max - min) * mid * 0.92)
        ctx.fillRect(i * step, top, Math.max(1, step), height)
      }
    }

    if (!clip) {
      // Auditioning: dim what falls outside the chosen range.
      if (audition && peaks && peaks.durationMs > 0) {
        const outMs = audition.outMs > 0 ? audition.outMs : peaks.durationMs
        const inX = (audition.inMs / peaks.durationMs) * box.width
        const outX = (outMs / peaks.durationMs) * box.width
        ctx.fillStyle = 'rgba(11,13,16,0.72)'
        ctx.fillRect(0, 0, inX, box.height)
        ctx.fillRect(outX, 0, box.width - outX, box.height)
      }
      return
    }

    const toX = (frame: number): number => (frame / Math.max(1, total)) * box.width
    const inX = toX(clip.inPoint)
    const outX = toX(clip.inPoint + clip.duration)

    // Dim what the clip excludes, so the kept region reads immediately.
    ctx.fillStyle = 'rgba(11,13,16,0.72)'
    ctx.fillRect(0, 0, inX, box.height)
    ctx.fillRect(outX, 0, box.width - outX, box.height)

    // Redraw the kept region brighter.
    if (peaks && peaks.buckets > 0) {
      const step = box.width / peaks.buckets
      ctx.save()
      ctx.beginPath()
      ctx.rect(inX, 0, outX - inX, box.height)
      ctx.clip()
      ctx.fillStyle = '#7d8b9c'
      for (let i = 0; i < peaks.buckets; i++) {
        const min = peaks.values[i * 2]
        const max = peaks.values[i * 2 + 1]
        const top = mid - max * mid * 0.92
        const height = Math.max(1, (max - min) * mid * 0.92)
        ctx.fillRect(i * step, top, Math.max(1, step), height)
      }
      ctx.restore()
    }

    ctx.strokeStyle = '#f97341'
    ctx.lineWidth = 2
    for (const x of [inX, outX]) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, box.height)
      ctx.stroke()
    }

    // Where the playhead sits inside the source, when it is over this clip.
    if (playhead >= clip.start && playhead < clip.start + clip.duration) {
      const sourceFrame = clip.inPoint + (playhead - clip.start)
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(toX(sourceFrame), 0)
      ctx.lineTo(toX(sourceFrame), box.height)
      ctx.stroke()
    }
  }, [peaks, box, clip, asset, playhead, audition])

  /* -------------------------------------------------------------- drag */

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: PointerEvent): void => {
      const rect = boxRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))

      if (clip && asset) {
        const frame = Math.round(ratio * asset.durationFrames)
        if (dragging === 'in') setSourceRange(clip.id, frame, clip.inPoint + clip.duration)
        else setSourceRange(clip.id, clip.inPoint, frame)
        return
      }

      // Auditioning: the handles define what will be inserted when placed.
      if (audition && peaks) {
        const ms = Math.round(ratio * peaks.durationMs)
        const outMs = audition.outMs > 0 ? audition.outMs : peaks.durationMs
        if (dragging === 'in') setAuditionRange(Math.min(ms, outMs - 10), outMs)
        else setAuditionRange(audition.inMs, Math.max(ms, audition.inMs + 10))
      }
    }

    const onUp = (): void => {
      setDragging(null)
      if (clip) commit()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, clip, asset, audition, peaks, setSourceRange, setAuditionRange, commit])

  if (!sourcePath) {
    return <Empty>Select a clip, or pick a sound in the Library, to see its waveform</Empty>
  }
  if (!hasAudio) {
    return <Empty>{sourceName} has no audio track</Empty>
  }

  // Auditioning a library file: show the waveform, but there is nothing on the
  // timeline to trim yet.
  if (!clip || !asset) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-ink-800 px-2.5 py-1.5">
          <span className="truncate text-[11px] text-ink-200">{sourceName}</span>
          <span className="shrink-0 text-[10px] text-ink-600">
            {peaks ? `${(peaks.durationMs / 1000).toFixed(2)}s` : ''}
          </span>
        </div>
        <div ref={attachBox} className="relative min-h-0 flex-1">
          <canvas ref={canvasRef} className="absolute inset-0" />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[11px] text-ink-600">
              <Loader2 size={12} className="animate-spin" /> reading audio
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[10.5px] text-red-400">
              {error}
            </div>
          )}
          {!loading && !error && peaks && peaks.durationMs > 0 && (
            <>
              {(['in', 'out'] as const).map((handle) => {
                const outMs = audition && audition.outMs > 0 ? audition.outMs : peaks.durationMs
                const ms = handle === 'in' ? (audition?.inMs ?? 0) : outMs
                const percent = (ms / Math.max(1, peaks.durationMs)) * 100
                return (
                  <div
                    key={handle}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      setDragging(handle)
                    }}
                    title={handle === 'in' ? 'Drag the start point' : 'Drag the end point'}
                    className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize"
                    style={{ left: `${percent}%` }}
                  >
                    <div className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-flame-500" />
                    <div className="absolute left-1/2 top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-ink-950 bg-flame-500" />
                  </div>
                )
              })}

              <button
                onClick={() => void addAuditionToTimeline()}
                className="absolute bottom-1 right-1 rounded bg-flame-500 px-2 py-0.5 text-[10px] font-medium text-ink-950 hover:bg-flame-400"
              >
                Add at playhead
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const total = Math.max(1, asset.durationFrames)
  const inPercent = (clip.inPoint / total) * 100
  const outPercent = ((clip.inPoint + clip.duration) / total) * 100

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-ink-800 px-2.5 py-1.5">
        <span className="truncate text-[11px] text-ink-200">{asset.name}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-600">
          {formatTimecode(clip.inPoint, fps)} – {formatTimecode(clip.inPoint + clip.duration, fps)}
        </span>
      </div>

      <div ref={attachBox} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0" />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[11px] text-ink-600">
            <Loader2 size={12} className="animate-spin" /> reading audio
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[10.5px] text-red-400">
            {error}
          </div>
        )}

        {(['in', 'out'] as const).map((handle) => (
          <div
            key={handle}
            onPointerDown={(e) => {
              e.preventDefault()
              setDragging(handle)
              begin()
            }}
            title={handle === 'in' ? 'Drag the start point' : 'Drag the end point'}
            className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${handle === 'in' ? inPercent : outPercent}%` }}
          >
            <div className="absolute left-1/2 top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-ink-950 bg-flame-500" />
          </div>
        ))}
      </div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-ink-600">
      {children}
    </div>
  )
}
