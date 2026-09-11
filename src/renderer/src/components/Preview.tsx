import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type React from 'react'
import type { Clip, CropRect, MediaAsset, Project } from '@shared/timeline'
import { clipEnd, framesToSeconds, sourceFrameFor, projectDuration } from '@shared/timeline'
import { ASPECTS, useEditor } from '../store'
import { mediaUrl } from '../media'
import { CropOverlay } from './CropOverlay'
import { activeCaptionStyle, captionAt, drawCaptions } from '../captionPreview'
import { useCatalog } from '../catalog'

export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
}

function fitTransform(sourceW: number, sourceH: number, boxW: number, boxH: number): ViewTransform {
  const scale = Math.min(boxW / sourceW, boxH / sourceH)
  return {
    scale,
    offsetX: (boxW - sourceW * scale) / 2,
    offsetY: (boxH - sourceH * scale) / 2
  }
}

/** Re-seek a media element only when it has drifted visibly. */
const DRIFT_TOLERANCE = 0.18

type MediaElement = HTMLVideoElement | HTMLImageElement

interface Layer {
  clip: Clip
  asset: MediaAsset
  element: MediaElement
  /** 0..1 — below 1 only while a transition is blending this clip in. */
  alpha: number
}

/** Every video clip live at a frame, bottom track first. */
function activeVideoClips(project: Project, frame: number): { clip: Clip; asset: MediaAsset }[] {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  return project.clips
    .filter((clip) => {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      if (!track || track.kind !== 'video' || track.hidden) return false
      return frame >= clip.start && frame < clipEnd(clip)
    })
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start)
    .map((clip) => ({ clip, asset: project.assets.find((a) => a.id === clip.assetId)! }))
    .filter((l) => Boolean(l.asset))
}

export function Preview(): ReactNode {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const aspect = useEditor((s) => s.aspect)
  const splitRatio = useEditor((s) => s.splitRatio)
  const setSplitRatio = useEditor((s) => s.setSplitRatio)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const loop = useEditor((s) => s.loop)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const holderRef = useRef<HTMLDivElement | null>(null)
  /**
   * One media element per clip, created lazily and reused.
   *
   * A single element cannot show a transition: both clips are on screen at once
   * and they are different files. The pool also gives multi-track preview for
   * free, since layering has the same requirement.
   */
  const pool = useRef(new Map<string, MediaElement>())
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const clockRef = useRef<{ at: number; frame: number } | null>(null)

  const [box, setBox] = useState({ width: 0, height: 0 })
  const [transform, setTransform] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 })

  const fps = project.settings.fps
  const ensureFont = useCatalog((s) => s.ensureFont)

  // Canvas silently falls back to a default face for a font it does not have.
  useEffect(() => {
    if (!project.captions.enabled) return
    void ensureFont(activeCaptionStyle(project).fontFamily)
  }, [project, ensureFont])

  useLayoutEffect(() => {
    const element = boxRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* --------------------------------------------------------- media pool */

  const elementFor = useCallback((clip: Clip, asset: MediaAsset): MediaElement => {
    const existing = pool.current.get(clip.id)
    if (existing) return existing

    const url = mediaUrl(asset.path)
    let element: MediaElement
    if (asset.kind === 'image') {
      const image = new Image()
      image.src = url
      element = image
    } else {
      const video = document.createElement('video')
      video.src = url
      video.preload = 'auto'
      video.playsInline = true
      element = video
    }
    // Kept in the DOM (hidden) because some browsers throttle decoding for
    // elements that were never attached.
    element.style.display = 'none'
    holderRef.current?.appendChild(element)
    pool.current.set(clip.id, element)
    return element
  }, [])

  // Discard elements for clips that no longer exist, or the pool grows forever.
  useEffect(() => {
    const live = new Set(project.clips.map((c) => c.id))
    for (const [clipId, element] of pool.current) {
      if (live.has(clipId)) continue
      if (element instanceof HTMLVideoElement) element.pause()
      element.remove()
      pool.current.delete(clipId)
    }
  }, [project.clips])

  useEffect(() => {
    const elements = pool.current
    const audio = audioRefs.current
    return () => {
      for (const [, element] of elements) {
        if (element instanceof HTMLVideoElement) element.pause()
        element.remove()
      }
      elements.clear()
      for (const [, element] of audio) element.pause()
      audio.clear()
    }
  }, [])

  /* ------------------------------------------------------- audio tracks */

  useEffect(() => {
    const elements = audioRefs.current
    const wanted = new Set<string>()

    for (const clip of project.clips) {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      if (!track || track.kind !== 'audio' || track.muted) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset?.hasAudio) continue

      wanted.add(clip.id)
      let element = elements.get(clip.id)
      if (!element) {
        element = new Audio(mediaUrl(asset.path))
        element.preload = 'auto'
        elements.set(clip.id, element)
      }
      element.volume = Math.max(0, Math.min(1, clip.volume ?? 1))
    }

    for (const [id, element] of elements) {
      if (wanted.has(id)) continue
      element.pause()
      element.removeAttribute('src')
      elements.delete(id)
    }
  }, [project.clips, project.tracks, project.assets])

  /** Keep every live media element at the right time, playing or paused. */
  const syncMedia = useCallback(
    (frame: number, isPlaying: boolean) => {
      const activeIds = new Set<string>()

      for (const { clip, asset } of activeVideoClips(project, frame)) {
        activeIds.add(clip.id)
        if (asset.kind === 'image') continue
        const video = pool.current.get(clip.id)
        if (!(video instanceof HTMLVideoElement)) continue

        const target = framesToSeconds(sourceFrameFor(clip, frame), fps)
        if (Math.abs(video.currentTime - target) > (isPlaying ? DRIFT_TOLERANCE : 0.02)) {
          video.currentTime = target
        }
        if (isPlaying && video.paused) void video.play().catch(() => undefined)
        if (!isPlaying && !video.paused) video.pause()
      }

      for (const [clipId, element] of pool.current) {
        if (activeIds.has(clipId)) continue
        if (element instanceof HTMLVideoElement && !element.paused) element.pause()
      }

      for (const [clipId, element] of audioRefs.current) {
        const clip = project.clips.find((c) => c.id === clipId)
        if (!clip) continue
        const live = frame >= clip.start && frame < clipEnd(clip)
        if (!live) {
          if (!element.paused) element.pause()
          continue
        }
        const target = framesToSeconds(sourceFrameFor(clip, frame), fps)
        if (Math.abs(element.currentTime - target) > DRIFT_TOLERANCE) element.currentTime = target
        if (isPlaying && element.paused) void element.play().catch(() => undefined)
        if (!isPlaying && !element.paused) element.pause()
      }
    },
    [project, fps]
  )

  useEffect(() => {
    if (!playing) syncMedia(playhead, false)
  }, [playhead, playing, syncMedia])

  useEffect(() => {
    clockRef.current = playing ? { at: performance.now(), frame: playhead } : null
    if (!playing) syncMedia(playhead, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  /* ------------------------------------------------------------- layers */

  const layersAtFrame = useCallback(
    (frame: number): Layer[] => {
      return activeVideoClips(project, frame).map(({ clip, asset }) => {
        const element = elementFor(clip, asset)

        // During its transition the incoming clip is partially transparent, so
        // whatever it overlaps shows through — the same thing the render does.
        let alpha = 1
        const transition = clip.transitionIn
        if (transition && transition.durationFrames > 0) {
          const into = frame - clip.start
          if (into < transition.durationFrames) {
            alpha = Math.max(0, Math.min(1, into / transition.durationFrames))
          }
        }
        return { clip, asset, element, alpha }
      })
    },
    [project, elementFor]
  )

  /* ---------------------------------------------------------- draw loop */

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const target = ASPECTS[aspect]
    const layers = layersAtFrame(playhead)

    canvas.width = Math.round(box.width * dpr)
    canvas.height = Math.round(box.height * dpr)
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0b0d10'
    ctx.fillRect(0, 0, box.width, box.height)

    // Two independent viewports, not one image wiped across. Comparing a 16:9
    // source with a 9:16 output needs both framings whole — a swipe shows half
    // of each and tells you nothing.
    const splitX = Math.round(box.width * splitRatio)
    const gutter = splitX > 0 && splitX < box.width ? 1 : 0
    const leftBox = { x: 0, y: 0, width: splitX - gutter, height: box.height }
    const rightBox = {
      x: splitX + gutter,
      y: 0,
      width: box.width - splitX - gutter,
      height: box.height
    }

    const top = layers[layers.length - 1] ?? null
    const naturalW = top?.asset.width ?? 16
    const naturalH = top?.asset.height ?? 9

    const ready = (element: MediaElement): boolean =>
      element instanceof HTMLVideoElement
        ? element.readyState >= 2
        : element.complete && element.naturalWidth > 0

    let sourceFit: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

    /* ----- left viewport: the whole source frame, reframe outlined ----- */
    if (leftBox.width > 8) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(leftBox.x, leftBox.y, leftBox.width, leftBox.height)
      ctx.clip()

      const fit = fitTransform(naturalW, naturalH, leftBox.width, leftBox.height)
      sourceFit = { ...fit, offsetX: fit.offsetX + leftBox.x, offsetY: fit.offsetY + leftBox.y }

      for (const layer of layers) {
        if (!ready(layer.element)) continue
        const w = layer.asset.width ?? naturalW
        const h = layer.asset.height ?? naturalH
        const layerFit = fitTransform(w, h, leftBox.width, leftBox.height)
        ctx.globalAlpha = layer.alpha
        ctx.drawImage(
          layer.element,
          leftBox.x + layerFit.offsetX,
          leftBox.y + layerFit.offsetY,
          w * layerFit.scale,
          h * layerFit.scale
        )
      }
      ctx.globalAlpha = 1

      const crop = top?.clip.crop
      if (crop) {
        ctx.fillStyle = 'rgba(8,10,13,0.66)'
        ctx.beginPath()
        ctx.rect(sourceFit.offsetX, sourceFit.offsetY, naturalW * sourceFit.scale, naturalH * sourceFit.scale)
        ctx.rect(
          sourceFit.offsetX + crop.x * sourceFit.scale,
          sourceFit.offsetY + crop.y * sourceFit.scale,
          crop.width * sourceFit.scale,
          crop.height * sourceFit.scale
        )
        ctx.fill('evenodd')
      }
      ctx.restore()
    }

    /* ----- right viewport: the finished frame, captions included ----- */
    if (rightBox.width > 8) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(rightBox.x, rightBox.y, rightBox.width, rightBox.height)
      ctx.clip()

      const fit = fitTransform(target.width, target.height, rightBox.width, rightBox.height)
      const frame = {
        x: rightBox.x + fit.offsetX,
        y: rightBox.y + fit.offsetY,
        width: target.width * fit.scale,
        height: target.height * fit.scale
      }

      ctx.fillStyle = '#000'
      ctx.fillRect(frame.x, frame.y, frame.width, frame.height)

      for (const layer of layers) {
        if (!ready(layer.element)) continue
        const w = layer.asset.width ?? naturalW
        const h = layer.asset.height ?? naturalH
        const crop: CropRect = layer.clip.crop ?? { x: 0, y: 0, width: w, height: h }
        const inner = fitTransform(crop.width, crop.height, frame.width, frame.height)
        ctx.globalAlpha = layer.alpha
        ctx.drawImage(
          layer.element,
          crop.x, crop.y, crop.width, crop.height,
          frame.x + inner.offsetX,
          frame.y + inner.offsetY,
          crop.width * inner.scale,
          crop.height * inner.scale
        )
      }
      ctx.globalAlpha = 1

      // Captions are drawn here rather than only at export: judging a style by
      // rendering a video first is an unusable feedback loop.
      if (project.captions.enabled && top) {
        const style = activeCaptionStyle(project)
        const caption = captionAt(project, top.clip, playhead, style)
        if (caption) drawCaptions(ctx, frame, style, caption)
      }
      ctx.restore()
    }

    if (gutter) {
      ctx.save()
      ctx.strokeStyle = 'rgba(249,115,65,0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(splitX + 0.5, 0)
      ctx.lineTo(splitX + 0.5, box.height)
      ctx.stroke()
      ctx.restore()
    }

    setTransform((prev) =>
      prev.scale === sourceFit.scale &&
      prev.offsetX === sourceFit.offsetX &&
      prev.offsetY === sourceFit.offsetY
        ? prev
        : sourceFit
    )
  }, [aspect, splitRatio, box.width, box.height, playhead, layersAtFrame, project])

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      draw()

      if (playing) {
        const layers = layersAtFrame(playhead)
        const clock = layers.find(
          (l) => l.element instanceof HTMLVideoElement && !l.element.paused
        )
        let next: number | null = null

        if (clock && clock.element instanceof HTMLVideoElement) {
          // A playing video is the most accurate clock available.
          next = clock.clip.start + Math.round(clock.element.currentTime * fps) - clock.clip.inPoint
          clockRef.current = { at: performance.now(), frame: next }
        } else {
          // Stills and gaps have no media clock, so fall back to wall time.
          const anchor = clockRef.current
          if (anchor) {
            next = anchor.frame + Math.round(((performance.now() - anchor.at) / 1000) * fps)
          }
        }

        if (next !== null) {
          const end = projectDuration(project)
          if (next >= end) {
            if (loop) {
              // Re-anchor the wall clock too, or the next tick computes a frame
              // from the old anchor and jumps straight back to the end.
              clockRef.current = { at: performance.now(), frame: 0 }
              setPlayhead(0)
              syncMedia(0, true)
            } else {
              setPlaying(false)
              setPlayhead(end)
            }
          } else {
            setPlayhead(next)
            syncMedia(next, true)
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draw, playing, playhead, fps, project, layersAtFrame, setPlayhead, setPlaying, syncMedia, loop])

  const topLayer = layersAtFrame(playhead).at(-1) ?? null
  const showCrop =
    splitRatio > 0.15 &&
    topLayer !== null &&
    topLayer.clip.id === selectedClipId &&
    topLayer.clip.crop !== undefined

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <div ref={boxRef} className="relative flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0" />
        <div ref={holderRef} className="hidden" />

        {showCrop && topLayer && (
          <CropOverlay clip={topLayer.clip} asset={topLayer.asset} transform={transform} />
        )}

        {splitRatio > 0.02 && splitRatio < 0.98 && (
          <SplitDivider ratio={splitRatio} onChange={setSplitRatio} containerRef={boxRef} />
        )}

        {splitRatio > 0.02 && splitRatio < 0.98 && (
          <>
            <span className="pointer-events-none absolute left-2 top-2 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-ink-400">
              Source
            </span>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-ink-400">
              Output
            </span>
          </>
        )}

        {topLayer === null && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-600">
            No clip under the playhead
          </div>
        )}
      </div>
    </div>
  )
}

function SplitDivider({
  ratio,
  onChange,
  containerRef
}: {
  ratio: number
  onChange: (ratio: number) => void
  containerRef: React.RefObject<HTMLDivElement | null>
}): ReactNode {
  const [dragging, setDragging] = useState(false)

  const move = useCallback(
    (clientX: number) => {
      const box = containerRef.current?.getBoundingClientRect()
      if (!box || box.width === 0) return
      onChange((clientX - box.left) / box.width)
    },
    [containerRef, onChange]
  )

  /**
   * Drag is tracked on the window, not the handle. The handle is 16px wide and
   * the pointer leaves it almost immediately, so the handle's own pointermove
   * drops the drag.
   */
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      e.preventDefault()
      move(e.clientX)
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, move])

  return (
    <div
      className="absolute top-0 z-30 h-full w-4 -translate-x-1/2 cursor-col-resize"
      style={{ left: `${ratio * 100}%` }}
      onPointerDown={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDoubleClick={() => onChange(0.5)}
      title="Drag to compare · double-click for an even split"
    >
      <div className={`mx-auto h-full w-0.5 ${dragging ? 'bg-flame-400' : 'bg-flame-500/90'}`} />
      <div
        className={`absolute left-1/2 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-ink-950 shadow-lg ${
          dragging ? 'bg-flame-400' : 'bg-flame-500'
        }`}
      >
        <span className="text-[9px] font-bold leading-none text-ink-950">||</span>
      </div>
    </div>
  )
}
