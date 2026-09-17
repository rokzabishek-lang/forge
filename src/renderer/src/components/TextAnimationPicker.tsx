import { useEffect, useRef, useState } from 'react'
import type { TextSpec } from '@shared/timeline'
import {
  TEXT_ANIMATIONS,
  animationFrames,
  piecesOf,
  textAnimationById
} from '@shared/render/textAnimation'
import { drawTextOnto } from '../textCanvas'

/**
 * Choosing how the words arrive.
 *
 * A list of names cannot answer the only question being asked — "what does
 * Bounce look like?" — so the name is a chip and the answer is a strip above
 * them that actually plays it, in the user's own font, style and words. Hovering
 * a chip previews it without committing; the selected one plays when nothing is
 * hovered, so the panel always shows what the clip is currently set to do.
 *
 * The strip is deliberately the only thing moving. Ten tiles each running their
 * own loop is ten canvases redrawn every frame for one answer nobody is reading
 * nine tenths of.
 */

/** The strip plays at a fixed rate of its own — the animations are in seconds. */
const PREVIEW_FPS = 60
/** How long the settled words are held before the loop starts over. */
const HOLD_FRAMES = 40

interface Props {
  spec: TextSpec
  onPick: (animationId: string | undefined) => void
}

export function TextAnimationPicker({ spec, onPick }: Props): React.JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Hover wins so a chip can be tried without losing what is already chosen.
  const showing = hovered === 'none' ? undefined : (hovered ?? spec.animationId)
  const animation = textAnimationById(showing)

  /*
   * A short sample.
   *
   * Three words is enough to read a stagger and short enough to stay large in a
   * strip this size; a whole caption would be shrunk to the point where the
   * movement is the only thing you cannot see.
   */
  const sample = spec.content.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ') || 'Your text'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const preview: TextSpec = {
      ...spec,
      content: sample,
      // The strip is a wide, short box and `size` is a fraction of its height,
      // so the clip's own size would draw type a few pixels tall.
      size: 0.46,
      offsetX: 0,
      offsetY: 0,
      position: 'center'
    }

    const pieces = animation ? piecesOf(sample, animation.scope).length : 1
    const loop = animation
      ? animationFrames(animation, PREVIEW_FPS, pieces) + HOLD_FRAMES
      : 1

    let raf = 0
    let frame = 0
    const paint = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(2, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(2, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.clearRect(0, 0, w, h)
      drawTextOnto(ctx, preview, w, h, animation ? { frame, fps: PREVIEW_FPS } : undefined)

      // Nothing to animate: draw the still words once and stop, rather than
      // burning a frame a millisecond redrawing an identical picture.
      if (!animation) return
      frame = (frame + 1) % loop
      raf = requestAnimationFrame(paint)
    }
    paint()
    return () => cancelAnimationFrame(raf)
    // The spec is the whole look; anything in it changes what should be drawn.
  }, [animation, sample, spec])

  const chip = (id: string | undefined, name: string, title: string): React.JSX.Element => {
    const on = (spec.animationId ?? undefined) === id
    return (
      <button
        key={id ?? 'none'}
        onClick={() => onPick(id)}
        onMouseEnter={() => setHovered(id ?? 'none')}
        onMouseLeave={() => setHovered(null)}
        title={title}
        className={`truncate rounded px-1.5 py-1 text-[10px] transition-colors ${
          on
            ? 'bg-flame-500 text-ink-950'
            : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
        }`}
      >
        {name}
      </button>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-ink-500">
        <span>Animation</span>
        {animation && <span className="truncate pl-2 text-ink-600">{animation.description}</span>}
      </div>

      <canvas
        ref={canvasRef}
        className="h-14 w-full rounded bg-ink-950"
        // The strip is a picture of the type, not a control.
        aria-hidden
      />

      <div className="grid grid-cols-3 gap-1">
        {chip(undefined, 'None', 'The words are simply there')}
        {TEXT_ANIMATIONS.map((a) => chip(a.id, a.name, a.description))}
      </div>
    </div>
  )
}
