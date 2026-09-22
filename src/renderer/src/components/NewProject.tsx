import { useState, type ReactNode } from 'react'
import { ASPECTS } from '../store'
import {
  NEW_PROJECT_ASPECTS,
  NEW_PROJECT_RATES,
  NEW_PROJECT_DEFAULT,
  type NewProjectChoice
} from '@shared/project/newProject'

/**
 * The one screen at the start.
 *
 * Three questions, one of which matters: the aspect decides the shape of every
 * edit that follows, and it was being assumed as 1920×1080 in an app for reels.
 * The other two have obvious defaults and are here because asking them costs
 * nothing once the screen exists.
 *
 * **9:16 first.** A list that puts landscape first teaches that landscape is
 * the normal answer, which for this app it is not.
 */
export function NewProject({
  onStart,
  onCancel
}: {
  onStart: (choice: NewProjectChoice) => void
  onCancel?: () => void
}): ReactNode {
  const [choice, setChoice] = useState<NewProjectChoice>(NEW_PROJECT_DEFAULT)

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink-950/80 p-6">
      <div className="w-full max-w-md rounded-lg border border-ink-700 bg-ink-900 p-5 shadow-2xl">
        <h2 className="mb-4 text-sm font-semibold text-ink-100">New project</h2>

        <label className="mb-4 block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-600">Name</span>
          <input
            autoFocus
            value={choice.name}
            onChange={(e) => setChoice((c) => ({ ...c, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onStart(choice)
            }}
            // Selected on focus so the placeholder name is replaced by typing
            // rather than appended to.
            onFocus={(e) => e.target.select()}
            className="w-full rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-ink-100 outline-none focus:border-flame-500"
          />
        </label>

        <div className="mb-4">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wide text-ink-600">
            Shape
          </span>
          <div className="grid grid-cols-3 gap-2">
            {NEW_PROJECT_ASPECTS.map(({ key, hint }) => {
              const on = choice.aspect === key
              const size = ASPECTS[key]
              return (
                <button
                  key={key}
                  onClick={() => setChoice((c) => ({ ...c, aspect: key }))}
                  className={`flex flex-col items-center gap-1.5 rounded border px-2 py-2.5 transition-colors ${
                    on
                      ? 'border-flame-500 bg-flame-500/10'
                      : 'border-ink-700 bg-ink-850 hover:border-ink-600'
                  }`}
                >
                  {/* The shape itself, drawn — a label alone makes someone do
                      the arithmetic to picture it. */}
                  <span
                    className={`rounded-[2px] ${on ? 'bg-flame-500' : 'bg-ink-600'}`}
                    style={{
                      width: key === '9:16' ? 15 : key === '1:1' ? 24 : 34,
                      height: key === '9:16' ? 27 : key === '1:1' ? 24 : 19
                    }}
                  />
                  <span className={`text-[11px] ${on ? 'text-flame-300' : 'text-ink-300'}`}>
                    {key}
                  </span>
                  <span className="text-center text-[9px] leading-tight text-ink-600">{hint}</span>
                  <span className="text-[9px] text-ink-700">
                    {size.width}×{size.height}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="mb-5">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wide text-ink-600">
            Frame rate
          </span>
          <div className="flex gap-2">
            {NEW_PROJECT_RATES.map(({ fps, hint }) => {
              const on = choice.fps === fps
              return (
                <button
                  key={fps}
                  onClick={() => setChoice((c) => ({ ...c, fps }))}
                  title={hint}
                  className={`flex-1 rounded border px-2 py-1.5 text-[11px] transition-colors ${
                    on
                      ? 'border-flame-500 bg-flame-500/10 text-flame-300'
                      : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
                  }`}
                >
                  {fps} fps
                  <span className="mt-0.5 block text-[9px] leading-tight text-ink-600">{hint}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onStart(choice)}
            className="flex-1 rounded bg-flame-500 px-3 py-2 text-[12px] font-medium text-ink-950 hover:bg-flame-400"
          >
            Start
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="rounded px-3 py-2 text-[12px] text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
