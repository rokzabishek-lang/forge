import { useState, type ReactNode } from 'react'
import {
  KEYED_PROPERTIES,
  MASK_PROPERTIES,
  PROPERTY_INFO,
  normaliseKeys,
  type KeyedProperty
} from '@shared/render/keyframes'
import { maskFieldOf } from '@shared/render/mask'
import { ColourCurve } from './ColourCurve'
import { CurveEditor } from './CurveEditor'
import { useEditor } from '../store'

/**
 * Curves, with room to work.
 *
 * This lived inside the inspector column, where it was about a hundred and fifty
 * pixels wide: the hint text wrapped, the graph was squeezed into a third of the
 * width, and a shape you are meant to judge by eye was too small to judge. Next
 * to the timeline it gets the width a curve actually needs, and it sits on the
 * same horizontal axis as the timeline — so the shape and the clip it belongs to
 * line up.
 *
 * Colour curves will live here too, as a second tab. Same panel, two kinds of
 * curve, one place to look for either.
 */
export function CurvePanel(): ReactNode {
  const project = useEditor((s) => s.project)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const playhead = useEditor((s) => s.playhead)
  const setKeyframes = useEditor((s) => s.setKeyframes)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const [property, setProperty] = useState<KeyedProperty>('zoom')
  /*
   * Two kinds of curve, one panel.
   *
   * "Motion" shapes how a value changes over time; "Colour" maps input
   * brightness to output. They look alike and mean completely different things,
   * so the tab is the only thing keeping them apart — but they want the same
   * width, and looking in one place for "the curve" is worth more than the
   * distinction costs.
   */
  const [kind, setKind] = useState<'motion' | 'colour'>('motion')
  const setColor = useEditor((s) => s.setColor)

  const clip = project.clips.find((c) => c.id === selectedClipId) ?? null
  /*
   * The mask's four tracks join the tabs when the clip has a mask — its centre
   * and size as curves, the same keys the Mask panel's Animate sets. A mask
   * track picked on another clip falls back to Zoom rather than a tab that is
   * not there.
   */
  const offered = [...KEYED_PROPERTIES, ...(clip?.mask ? MASK_PROPERTIES : [])]
  const shown = offered.includes(property) ? property : 'zoom'
  const field = maskFieldOf(shown)
  const rest = field && clip?.mask ? clip.mask.shape[field] : undefined

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-ink-850 bg-ink-900">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-ink-850 px-2">
        {(['motion', 'colour'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setKind(key)}
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors ${
              kind === key ? 'text-ink-200' : 'text-ink-600 hover:text-ink-400'
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      {/*
        The properties on a row of their own.

        They shared the header with Motion and Colour and were pushed off its
        right edge at an ordinary window width — Opacity and Volume were
        simply not there to click. On their own row all four always fit.
      */}
      {kind === 'motion' && (
        <div className="flex shrink-0 flex-wrap gap-0.5 border-b border-ink-850 px-2 py-1">
          {offered.map((key) => {
            const has = (clip?.keyframes?.[key]?.length ?? 0) > 0
            return (
              <button
                key={key}
                onClick={() => setProperty(key)}
                title={
                  has
                    ? `${PROPERTY_INFO[key].label} — animated`
                    : `${PROPERTY_INFO[key].label} — nothing keyed yet`
                }
                className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  shown === key
                    ? 'bg-ink-800 text-ink-200'
                    : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
                }`}
              >
                {PROPERTY_INFO[key].label}
                {/* A dot rather than a count: which properties move is the
                    question, not how many keys each has. */}
                {has && <span className="ml-1 text-flame-500">•</span>}
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!clip ? (
          <p className="text-[10.5px] leading-snug text-ink-600">
            Select a clip to shape how it moves, or how it is graded.
          </p>
        ) : kind === 'colour' ? (
          <ColourCurve
            curves={clip.color?.curves}
            onChange={(curves) => setColor(clip.id, { curves })}
          />
        ) : (
          <>
            <CurveEditor
              property={shown}
              rest={rest}
              keys={normaliseKeys(clip.keyframes?.[shown] ?? [], clip.duration)}
              durationFrames={clip.duration}
              playheadFrame={Math.round(playhead - clip.start)}
              onChange={(next) => setKeyframes(clip.id, shown, next)}
              onScrub={(frame) => setPlayhead(clip.start + frame)}
            />
            <p className="mt-2 text-[10px] leading-snug text-ink-600">
              Time runs left to right across the clip. Click to add a point, drag one to move it,
              double-click to remove it — or press Draw and sketch the whole shape.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
