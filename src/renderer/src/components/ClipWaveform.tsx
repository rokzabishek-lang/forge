import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Clip, MediaAsset } from '@shared/timeline'
import { bucketsForSource, clipBars } from '@shared/render/waveBars'
import { sourceFramesFor } from '@shared/render/speed'
import { cachedPeaks, loadPeaks, type Peaks } from '../peaks'

/**
 * The sound, drawn on the clip.
 *
 * The trimmer has had a waveform since early on, but the trimmer is a panel
 * about one selected clip. Editing happens on the timeline, and until now the
 * timeline showed a grey box with a filename on it — so "cut just before he
 * says it" meant scrubbing to find the word, and the volume line added
 * yesterday was a control aimed at something invisible.
 *
 * Behind the volume line, and behind the name, because it is scenery: nothing
 * here takes a pointer event. Dragging and trimming the clip must keep working
 * exactly as they do on a clip with no sound at all.
 */

/** Chrome tolerates far more, but nothing here needs more. */
const MAX_BACKING = 16384
/** A waveform gains nothing from a third device pixel. */
const MAX_DPR = 2

export function ClipWaveform({
  clip,
  asset,
  zoom,
  height,
  fps,
  selected
}: {
  clip: Clip
  asset: MediaAsset
  /** Pixels per frame. */
  zoom: number
  height: number
  fps: number
  selected: boolean
}): ReactNode {
  const buckets = bucketsForSource(asset.durationFrames, fps)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [peaks, setPeaks] = useState<Peaks | null>(
    () => cachedPeaks(asset.path, buckets) ?? null
  )

  useEffect(() => {
    if (peaks) return
    let cancelled = false
    void loadPeaks(asset.path, buckets)
      .then((result) => {
        if (!cancelled) setPeaks(result)
      })
      // Silently: a clip is not the place to report that ffmpeg could not read
      // a file. The trimmer says so in words when the clip is selected, and a
      // red box on the timeline would be a permanent alarm about one bad file.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [asset.path, buckets, peaks])

  /*
   * A video clip gets the lower half; a sound file gets all of it.
   *
   * Both Premiere and Resolve draw a linked A/V clip this way, and the reason
   * survives the copying: a video clip has other things to say — its name now,
   * thumbnails later — and a waveform across the whole of it crowds them out.
   * A sound file has nothing else to show, so giving it half the height just
   * makes the beats harder to see.
   *
   * It stays on video AT ALL because speech lives there. A wedding's vows are
   * on the camera clip, not on a separate track, and "cut just before he says
   * it" is the cut you would otherwise scrub blind for.
   */
  const band = asset.hasVideo ? Math.round(height * 0.52) : height
  const cssWidth = Math.max(1, clip.duration * zoom)
  /*
   * How much FILE the clip covers, which is not how long it is.
   *
   * A clip at half speed shows half as much source over the same width, so a
   * waveform drawn from `duration` alone would be stretched to twice its true
   * span — and every beat in it would be in the wrong place by a growing
   * amount. `sourceFramesFor` is the same helper the render and the seek use.
   */
  const sourceFrames = sourceFramesFor(clip)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const usable = peaks ? Math.min(peaks.buckets, Math.floor(peaks.values.length / 2)) : 0
    const analysedFrames = peaks ? (peaks.durationMs / 1000) * fps : 0

    /*
     * Draw at the resolution the DATA has, and let CSS stretch the rest.
     *
     * A ten-minute clip at maximum zoom is two hundred thousand pixels wide —
     * past what a canvas can allocate, and pointless besides, since there are
     * only a few thousand buckets behind it. Capping the drawing at two pixels
     * per bucket and stretching to the clip's real width throws away nothing
     * that was measured, and keeps the canvas small at every zoom.
     */
    const dataWidth = Math.ceil((sourceFrames / Math.max(1, analysedFrames)) * usable * 2)
    const drawWidth = Math.max(
      1,
      Math.min(cssWidth, Math.max(1, dataWidth), Math.floor(MAX_BACKING / MAX_DPR))
    )

    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(drawWidth * dpr))
    canvas.height = Math.max(1, Math.round(band * dpr))
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${band}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, drawWidth, band)
    if (!peaks || usable === 0) return

    const bars = clipBars({
      values: peaks.values,
      buckets: usable,
      analysedFrames,
      inPoint: clip.inPoint,
      sourceFrames,
      width: drawWidth,
      height: band
    })

    /*
     * Dim on purpose.
     *
     * At full strength this reads as a bar chart filling the clip — the name
     * fights it, the selection border stops registering, and the orange volume
     * line drawn on top of it competes with a wall of grey instead of sitting
     * over a texture. A waveform on a timeline is scenery you glance at to find
     * a beat, not the subject of the panel.
     */
    ctx.fillStyle = selected ? 'rgba(255,224,209,0.38)' : 'rgba(158,183,208,0.3)'
    for (const bar of bars) ctx.fillRect(bar.x, bar.top, bar.width, bar.height)
  }, [peaks, cssWidth, band, fps, clip.inPoint, sourceFrames, selected])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-waveform={clip.id}
      className="pointer-events-none absolute bottom-0 left-0"
    />
  )
}
