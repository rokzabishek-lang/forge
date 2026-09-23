import { type ReactNode } from 'react'
import { Pipette } from 'lucide-react'
import type { Clip } from '@shared/timeline'
import { BLEND_RANGE, DEFAULT_KEY, SIMILARITY_RANGE, saneKey } from '@shared/render/chromaKey'
import { useEditor } from '../store'
import { Slider } from './Slider'

/**
 * Chroma key — take a green or blue screen out of a clip.
 *
 * Above the colour controls because that is the order it happens in: the key
 * is measured on the picture as it arrived, and only what is left gets graded.
 * Grading first would move the greens the key is looking for.
 *
 * The colour is picked from the picture rather than typed. Nobody knows the hex
 * of their screen, and a real screen is never the textbook green anyway — it is
 * whatever the light made it, which is exactly what the pick samples.
 */
export function KeyPanel({ clip }: { clip: Clip }): ReactNode {
  const setKey = useEditor((s) => s.setKey)
  const previewTool = useEditor((s) => s.previewTool)
  const setPreviewTool = useEditor((s) => s.setPreviewTool)
  const picking = previewTool === 'key'

  if (!clip.key) {
    return (
      <div className="space-y-1.5 border-t border-ink-850 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-ink-400">Key</span>
          <button
            onClick={() => {
              setKey(clip.id, DEFAULT_KEY)
              setPreviewTool('key')
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-ink-500 hover:bg-ink-800 hover:text-ink-200"
          >
            Add
          </button>
        </div>
        <p className="text-[9.5px] leading-snug text-ink-600">
          Take a green or blue screen out, so the track below shows through.
        </p>
      </div>
    )
  }

  const key = saneKey(clip.key)

  return (
    <div className="space-y-1.5 border-t border-ink-850 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Key</span>
        <button
          onClick={() => {
            setKey(clip.id, undefined)
            if (picking) setPreviewTool('select')
          }}
          className="rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200"
        >
          Remove
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Screen</span>
        <span
          className="size-4 shrink-0 rounded border border-ink-700"
          style={{ backgroundColor: key.color }}
          title={key.color}
        />
        {/*
         * Picking is a mode, and it says so: while it is on the preview shows
         * this clip as it arrived — no key, no grade, nothing over it — so the
         * click lands on the colour that is really there.
         */}
        <button
          onClick={() => setPreviewTool(picking ? 'select' : 'key')}
          title="Click the screen in the preview to take its colour"
          className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            picking
              ? 'bg-flame-500 font-medium text-ink-950'
              : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
          }`}
        >
          <Pipette size={11} strokeWidth={2} />
          {picking ? 'Click the screen…' : 'Pick from picture'}
        </button>
      </div>

      <Slider
        label="Range"
        value={Math.round(key.similarity * 100)}
        min={Math.round(SIMILARITY_RANGE.min * 100)}
        max={Math.round(SIMILARITY_RANGE.max * 100)}
        suffix=""
        onChange={(v) => setKey(clip.id, { ...key, similarity: v / 100 })}
      />
      <Slider
        label="Soften"
        value={Math.round(key.blend * 100)}
        min={Math.round(BLEND_RANGE.min * 100)}
        max={Math.round(BLEND_RANGE.max * 100)}
        suffix=""
        onChange={(v) => setKey(clip.id, { ...key, blend: v / 100 })}
      />
      <Slider
        label="Despill"
        value={Math.round(key.despill * 100)}
        min={0}
        max={100}
        suffix="%"
        onChange={(v) => setKey(clip.id, { ...key, despill: v / 100 })}
      />
      <p className="text-[9.5px] leading-snug text-ink-600">
        Range takes out colours near the screen; Soften feathers the edge; Despill pulls the
        screen’s colour off hair and edges.
      </p>
    </div>
  )
}
