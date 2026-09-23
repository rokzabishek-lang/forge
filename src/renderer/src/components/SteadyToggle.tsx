import { type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { useEditor } from '../store'

/**
 * Steady — take a handheld shake out of a clip (render/steady.ts).
 *
 * A toggle rather than a panel: the stabiliser's own settings were measured
 * (smoothing 30 took a jittered marker from 7.6 px of spread to half a pixel)
 * and a wedding editor wants it on or off, not tuned. It is honest about the
 * one thing it cannot do: the preview has no stabiliser, so the clip plays as
 * shot until it is exported.
 */
export function SteadyToggle({ clip }: { clip: Clip }): ReactNode {
  const setSteady = useEditor((s) => s.setSteady)
  const on = Boolean(clip.steady)
  return (
    <div className="space-y-1 border-t border-ink-850 pt-2">
      <button
        onClick={() => setSteady(clip.id, !on)}
        title="Smooth out a handheld shake. The export analyses the clip's motion first, so it takes a little longer."
        className={`w-full rounded px-1.5 py-1 text-left text-[10px] transition-colors ${
          on ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
        }`}
      >
        {on ? 'Steady — smoothing the shake' : 'Steady'}
      </button>
      {on && (
        <p className="text-[9.5px] leading-snug text-ink-600">
          Applied when you export — the preview shows the clip as it was shot. It zooms in just
          enough that the steadied picture never shows its edge.
        </p>
      )}
    </div>
  )
}
