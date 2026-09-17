import { type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import {
  DEFAULT_PIP,
  PIP_SPOTS,
  PIP_SHAPE_LABEL,
  PIP_SPOT_LABEL,
  SPLIT_HINT,
  SPLIT_LABEL,
  type PipShape,
  type PipSpot,
  type SplitLayout
} from '@shared/render/layout'
import { useEditor } from '../store'

/**
 * Split screen and picture-in-picture.
 *
 * Two layouts that the transform could always express — a box of some size, in
 * some corner, filled rather than letterboxed — and which nobody could reach
 * because there was no button for them. So this panel is almost entirely
 * presets: it writes the numbers and gets out of the way. Everything it sets
 * stays draggable in the preview afterwards, which is the point of doing it
 * this way rather than as a mode.
 */

/** The corner buttons, laid out as the corners they refer to. */
const SPOT_GRID: (PipSpot | null)[] = [
  'top-left',
  null,
  'top-right',
  null,
  'centre',
  null,
  'bottom-left',
  null,
  'bottom-right'
]

const SHAPES: { shape: PipShape; radius: number }[] = [
  { shape: 'frame', radius: 0.12 },
  { shape: 'square', radius: 0.12 },
  { shape: 'circle', radius: 0 },
  { shape: 'portrait', radius: 0.12 }
]

export function LayoutPanel({ clip }: { clip: Clip }): ReactNode {
  const splitWithClipBelow = useEditor((s) => s.splitWithClipBelow)
  const makePip = useEditor((s) => s.makePip)
  const setTransform = useEditor((s) => s.setTransform)
  const setMask = useEditor((s) => s.setMask)

  const t = clip.transform
  /*
   * Is this clip already laid out?
   *
   * A box narrower or shorter than the frame means something put it there. It
   * is a heuristic rather than a stored flag on purpose: a clip the user then
   * drags by hand is still a picture-in-picture, and a flag would go stale the
   * moment they touched it.
   */
  const placed = (t?.scale ?? 1) < 0.98 || (t?.scaleY ?? t?.scale ?? 1) < 0.98

  const reset = (): void => {
    setTransform(clip.id, { x: 0, y: 0, scale: 1, scaleY: 1, fit: 'contain' })
    if (clip.mask?.mode === 'reveal') setMask(clip.id, undefined)
  }

  return (
    <div className="space-y-1.5 border-t border-ink-850 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Layout</span>
        {placed && (
          <button
            onClick={reset}
            className="rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200"
          >
            Full frame
          </button>
        )}
      </div>

      {/* Split screen — needs the clip underneath, so it reads as one action. */}
      <div className="grid grid-cols-2 gap-1">
        {(['rows', 'columns'] as SplitLayout[]).map((layout) => (
          <button
            key={layout}
            onClick={() => splitWithClipBelow(clip.id, layout)}
            title={SPLIT_HINT[layout]}
            className="rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
          >
            {SPLIT_LABEL[layout]}
          </button>
        ))}
      </div>

      <div className="pt-0.5 text-[10px] leading-snug text-ink-600">
        Splits this clip with the one on the track below.
      </div>

      {/* Picture in picture — shape first, then where it sits. */}
      <div className="grid grid-cols-4 gap-1 pt-1">
        {SHAPES.map(({ shape, radius }) => (
          <button
            key={shape}
            onClick={() => makePip(clip.id, { shape, radius })}
            title={`Picture in picture — ${PIP_SHAPE_LABEL[shape].toLowerCase()}`}
            className="flex h-9 items-center justify-center rounded bg-ink-800 hover:bg-ink-700"
          >
            <Glyph shape={shape} />
          </button>
        ))}
      </div>

      {placed && (
        <div className="grid grid-cols-3 gap-1 pt-0.5">
          {SPOT_GRID.map((spot, index) =>
            spot ? (
              <button
                key={spot}
                onClick={() => makePip(clip.id, { spot, radius: clip.mask ? undefined : 0.12 })}
                title={PIP_SPOT_LABEL[spot]}
                className="flex h-6 items-center justify-center rounded bg-ink-800 hover:bg-ink-700"
              >
                <span className="block size-1.5 rounded-[1px] bg-ink-500" />
              </button>
            ) : (
              <span key={index} />
            )
          )}
        </div>
      )}
    </div>
  )
}

/** A small drawing of the box each shape produces — faster to read than a word. */
function Glyph({ shape }: { shape: PipShape }): ReactNode {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-ink-400" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.35" />
      {shape === 'circle' ? (
        <circle cx="16" cy="14" r="5" {...common} />
      ) : shape === 'square' ? (
        <rect x="11" y="9" width="10" height="10" rx="2" {...common} />
      ) : shape === 'portrait' ? (
        <rect x="13" y="7" width="8" height="12" rx="2" {...common} />
      ) : (
        <rect x="11" y="10" width="10" height="9" rx="2" {...common} />
      )}
    </svg>
  )
}

export { DEFAULT_PIP, PIP_SPOTS }
