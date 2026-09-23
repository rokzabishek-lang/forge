import { type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Circle, Diamond, Minus, Square } from 'lucide-react'
import type { Clip } from '@shared/timeline'
import {
  MASK_MODE_HINT,
  MASK_MODE_LABEL,
  defaultMask,
  isMaskAnimated,
  maskAt,
  maskKeyFrames,
  type MaskKind,
  type MaskMode
} from '@shared/render/mask'
import { useEditor } from '../store'
import { Slider } from './Slider'

/**
 * The numbers behind the shape on the picture.
 *
 * Dragging answers "is it on her face?"; this answers "how soft is the edge?"
 * and "what is happening inside?" — questions a handle cannot express. The two
 * are the same mask, so anything changed here moves the outline in the preview
 * immediately.
 */

const KINDS: { id: MaskKind; label: string; icon: typeof Circle }[] = [
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'rectangle', label: 'Rectangle', icon: Square },
  { id: 'linear', label: 'Linear — everything on one side of a line', icon: Minus }
]

const MODES: MaskMode[] = ['blur', 'grade', 'reveal']

export function MaskPanel({ clip }: { clip: Clip }): ReactNode {
  const setMask = useEditor((s) => s.setMask)
  const setMaskShape = useEditor((s) => s.setMaskShape)
  const setPreviewTool = useEditor((s) => s.setPreviewTool)
  const previewTool = useEditor((s) => s.previewTool)
  const animateMask = useEditor((s) => s.animateMask)
  const playhead = useEditor((s) => s.playhead)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  /*
   * The mask as it stands at the playhead. The sliders read this, and a slider
   * moved on an animated mask keys the playhead (store: setMaskShape) — so what
   * they show and what they change are the same moment.
   */
  const frame = playhead - clip.start
  const mask = maskAt(clip, frame)
  const animated = isMaskAnimated(clip.keyframes)
  const keys = animated ? maskKeyFrames(clip.keyframes) : []
  const onKey = keys.includes(Math.round(frame))
  // Writes go to the STORED mask (`clip.mask`); `mask` is only what shows now.
  // Spreading `mask` into setMask would bake this frame's keyed values in.
  const previous = [...keys].reverse().find((k) => k < Math.round(frame))
  const next = keys.find((k) => k > Math.round(frame))

  if (!mask) {
    return (
      <div className="space-y-1.5 border-t border-ink-850 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-ink-400">Mask</span>
          <button
            onClick={() => {
              setMask(clip.id, defaultMask('blur'))
              setPreviewTool('mask')
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-ink-500 hover:bg-ink-800 hover:text-ink-200"
          >
            Add
          </button>
        </div>
        <p className="text-[9.5px] leading-snug text-ink-600">
          A shape on the picture, with a blur, a colour change or a cut-out confined to it.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 border-t border-ink-850 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Mask</span>
        <div className="flex items-center gap-0.5">
          {/*
           * Editing the shape is a mode, and a mode you cannot see you are in is
           * a mode that confuses people. The toggle says which way it is.
           */}
          <button
            onClick={() => setPreviewTool(previewTool === 'mask' ? 'select' : 'mask')}
            title="Show the shape on the picture and drag it there"
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              previewTool === 'mask'
                ? 'bg-ink-800 text-ink-200'
                : 'text-ink-600 hover:bg-ink-800 hover:text-ink-200'
            }`}
          >
            Edit on picture
          </button>
          <button
            onClick={() => {
              setMask(clip.id, undefined)
              if (previewTool === 'mask') setPreviewTool('select')
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200"
          >
            Remove
          </button>
        </div>
      </div>

      {/*
        Animate: the centre and size follow keys, like any keyframed value.

        Off is the mask as it always was. On puts a key where the shape is,
        and from then on moving or resizing it — on the picture or with the
        sliders — keys the playhead. Turning it off keeps what is on screen.
      */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => animateMask(clip.id, !animated)}
          title={
            animated
              ? 'Stop animating — the shape stays as it is at the playhead'
              : 'Animate the shape: move or resize it at different moments and it follows'
          }
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            animated ? 'bg-flame-500 font-medium text-ink-950' : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
          }`}
        >
          <Diamond size={10} strokeWidth={2.2} className={onKey ? 'fill-current' : ''} />
          {animated ? 'Animated' : 'Animate'}
        </button>
        {animated && (
          <>
            <span className="text-[9.5px] text-ink-600">
              {keys.length} {keys.length === 1 ? 'key' : 'keys'}
            </span>
            <div className="ml-auto flex items-center">
              <button
                onClick={() => previous !== undefined && setPlayhead(clip.start + previous)}
                disabled={previous === undefined}
                title="The mask's previous key"
                className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
              >
                <ChevronLeft size={12} />
              </button>
              <button
                onClick={() => next !== undefined && setPlayhead(clip.start + next)}
                disabled={next === undefined}
                title="The mask's next key"
                className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
              >
                <ChevronRight size={12} />
              </button>
            </div>
          </>
        )}
      </div>
      {animated && (
        <p className="text-[9.5px] leading-snug text-ink-600">
          Move the playhead, then move or resize the shape: it keys there and glides between keys.
          Its curves are in the graph beside the timeline.
        </p>
      )}

      {/* Shape. */}
      <div className="flex items-center gap-1">
        {KINDS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setMaskShape(clip.id, { kind: id })}
            title={label}
            className={`flex h-6 flex-1 items-center justify-center rounded transition-colors ${
              mask.shape.kind === id
                ? 'bg-ink-800 text-ink-100'
                : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
            }`}
          >
            <Icon size={13} strokeWidth={1.8} />
          </button>
        ))}
      </div>

      {/* What happens inside it. */}
      <div className="flex items-center gap-0.5">
        {MODES.map((mode) => (
          <button
            key={mode}
            onClick={() => setMask(clip.id, { ...clip.mask!, mode })}
            title={MASK_MODE_HINT[mode]}
            className={`flex-1 truncate rounded px-1 py-0.5 text-[10px] transition-colors ${
              mask.mode === mode
                ? 'bg-ink-800 text-ink-100'
                : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
            }`}
          >
            {MASK_MODE_LABEL[mode].replace(/ (only )?inside$/, '')}
          </button>
        ))}
      </div>
      <p className="text-[9.5px] leading-snug text-ink-600">{MASK_MODE_HINT[mask.mode]}</p>

      {mask.mode === 'blur' && (
        <Slider
          label="Amount"
          value={Math.round(mask.blur)}
          min={0}
          max={120}
          suffix="px"
          onChange={(v) => setMask(clip.id, { ...clip.mask!, blur: v })}
        />
      )}

      <Slider
        label="Feather"
        value={Math.round(mask.shape.feather * 100)}
        min={0}
        max={100}
        suffix="%"
        onChange={(v) => setMaskShape(clip.id, { feather: v / 100 })}
      />
      {mask.shape.kind !== 'linear' && (
        <>
          <Slider
            label="Width"
            value={Math.round(mask.shape.width * 200)}
            min={1}
            max={200}
            suffix="%"
            onChange={(v) => setMaskShape(clip.id, { width: v / 200 })}
          />
          <Slider
            label="Height"
            value={Math.round(mask.shape.height * 200)}
            min={1}
            max={200}
            suffix="%"
            onChange={(v) => setMaskShape(clip.id, { height: v / 200 })}
          />
        </>
      )}
      <Slider
        label="Angle"
        value={Math.round(mask.shape.rotation)}
        min={-180}
        max={180}
        suffix="°"
        onChange={(v) => setMaskShape(clip.id, { rotation: v })}
      />

      <button
        onClick={() => setMaskShape(clip.id, { invert: !mask.shape.invert })}
        className={`w-full rounded px-1.5 py-1 text-[10px] transition-colors ${
          mask.shape.invert
            ? 'bg-ink-800 text-ink-100'
            : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
        }`}
      >
        {mask.shape.invert ? 'Inverted — outside the shape' : 'Invert'}
      </button>
    </div>
  )
}
