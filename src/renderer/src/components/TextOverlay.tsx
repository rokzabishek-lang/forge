import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import type { Clip, TextSpec } from '@shared/timeline'
import { centreFix, layoutText } from '@shared/render/textLayout'
import { useEditor } from '../store'
import { startDrag as beginGesture } from '../drag'

/**
 * Editing text on the picture, where it lives.
 *
 * Selecting a text clip and hunting for a field in a side panel is how you get
 * a black card you cannot work out how to change. Click the words and type, drag
 * them where you want them, pull the corner to size them.
 *
 * It draws over the preview canvas rather than inside it, so the canvas stays a
 * pure render of the timeline and the caret is a real caret.
 */

/** Below this, a press is a click; above it, the user meant to drag. */
const DRAG_SLOP = 3

export function TextOverlay({
  clip,
  frame,
  canvas
}: {
  clip: Clip
  /** The finished frame's rectangle inside the preview box, in CSS pixels. */
  frame: { x: number; y: number; width: number; height: number }
  /** The project canvas, in project pixels. */
  canvas: { width: number; height: number }
}): ReactNode {
  const setText = useEditor((s) => s.setText)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(clip.text?.content ?? '')
  /*
   * What the user is currently dragging, held locally so the words track the
   * mouse at screen rate. The store is deliberately behind — it redraws a PNG.
   */
  const [live, setLive] = useState<Partial<TextSpec> | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  const stored = clip.text

  // Only when the selection moves to a different clip. Resyncing on every
  // content change would throw the user out of the box mid-edit, because the
  // commit that saves their typing is itself a content change.
  useEffect(() => {
    setDraft(stored?.content ?? '')
    setEditing(false)
    setLive(null)
  }, [clip.id])

  useEffect(() => {
    if (!editing) return
    const area = areaRef.current
    if (!area) return
    area.focus()
    area.select()
  }, [editing])

  if (!stored) return null
  const spec: TextSpec = live ? { ...stored, ...live } : stored

  /*
   * Placement comes from the shared layout, the same one the baked PNG uses.
   *
   * This used to work the position out for itself in CSS. Two copies of a
   * placement rule is two chances for the box you drag to sit somewhere the
   * export does not — and they did drift.
   */
  const scale = frame.width / canvas.width
  const layout = layoutText(spec, canvas.width, canvas.height)
  const fontPx = layout.fontPx * scale

  const commit = (): void => {
    setEditing(false)
    if (draft !== spec.content) void setText(clip.id, { content: draft })
  }

  /**
   * Press-and-move drags; press-and-release edits.
   *
   * One gesture doing both is why this needs pointer capture rather than a
   * double-click: a hidden affordance is the same as no affordance.
   */
  const startDrag = (e: ReactPointerEvent): void => {
    if (editing) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const baseX = spec.offsetX ?? 0
    const baseY = spec.offsetY ?? 0
    let moved = false

    beginGesture(e, {
      onFrame: (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return
        moved = true
        // Clamped to roughly half the canvas either way, so text cannot be
        // dragged somewhere it can never be found again.
        const next = {
          offsetX: clamp(baseX + dx / frame.width, -0.5, 0.5),
          offsetY: clamp(baseY + dy / frame.height, -0.5, 0.5)
        }
        setLive(next)
        void setText(clip.id, next)
      },
      onEnd: () => {
        setLive(null)
        // A press that never moved was a click, and a click opens the editor.
        if (!moved) setEditing(true)
      }
    })
  }

  /** Corner handle: vertical drag is size, because type scales on one axis. */
  const startResize = (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const baseSize = spec.size

    beginGesture(e, {
      onFrame: (ev: PointerEvent) => {
        const next = { size: clamp(baseSize + (ev.clientY - startY) / frame.height, 0.02, 0.4) }
        setLive(next)
        void setText(clip.id, next)
      },
      onEnd: () => setLive(null)
    })
  }

  const shared = {
    fontFamily: spec.font,
    fontSize: `${fontPx}px`,
    fontWeight: spec.weight,
    letterSpacing: `${layout.tracking * scale}px`,
    lineHeight: `${layout.lineHeight * scale}px`,
    color: spec.color,
    textAlign: spec.align,
    textTransform: (spec.uppercase ? 'uppercase' : 'none') as 'uppercase' | 'none',
    textShadow:
      spec.shadow > 0 ? `0 ${fontPx * 0.05}px ${fontPx * 0.14}px rgba(0,0,0,${spec.shadow})` : 'none'
  }

  return (
    <div
      className="absolute"
      style={{
        // Anchored exactly where the layout puts the type, then pulled back by
        // however much of the block sits left of that anchor.
        left: frame.x + (layout.x + centreFix(layout)) * scale,
        top: frame.y + layout.top * scale,
        transform:
          layout.anchor === 'middle'
            ? 'translateX(-50%)'
            : layout.anchor === 'end'
              ? 'translateX(-100%)'
              : undefined,
        maxWidth: frame.width - layout.marginX * scale,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent:
          spec.align === 'left' ? 'flex-start' : spec.align === 'right' ? 'flex-end' : 'center',
        pointerEvents: 'none'
      }}
    >
      {editing ? (
        <textarea
          ref={areaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Enter commits, shift+enter is a new line — a title is usually one
            // line and having to reach for the mouse to finish is worse.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              setDraft(spec.content)
              setEditing(false)
            }
            e.stopPropagation()
          }}
          rows={Math.max(1, draft.split('\n').length)}
          style={{
            ...shared,
            pointerEvents: 'auto',
            width: `${Math.max(120, frame.width * 0.5)}px`,
            // Opaque enough to hide the rendered words underneath, which are
            // still the old ones until the redraw lands.
            background: 'rgba(10,10,12,0.82)',
            border: '1px solid rgba(249,115,65,0.9)',
            borderRadius: 2,
            outline: 'none',
            resize: 'none',
            padding: 0,
            overflow: 'hidden'
          }}
        />
      ) : (
        <div
          onPointerDown={startDrag}
          title="Click to edit, drag to move"
          style={{
            ...shared,
            position: 'relative',
            pointerEvents: 'auto',
            cursor: 'move',
            // A dashed box on the words themselves, so it is obvious they are
            // editable without hiding what they look like.
            outline: '1px dashed rgba(249,115,65,0.75)',
            outlineOffset: `${Math.max(2, fontPx * 0.08)}px`,
            whiteSpace: 'pre-wrap',
            maxWidth: '100%'
          }}
        >
          {spec.content || ' '}
          <span
            onPointerDown={startResize}
            title="Drag to resize"
            style={{
              position: 'absolute',
              right: -6,
              bottom: -6,
              width: 12,
              height: 12,
              borderRadius: 2,
              background: 'rgb(249,115,65)',
              cursor: 'ns-resize',
              pointerEvents: 'auto'
            }}
          />
        </div>
      )}
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
