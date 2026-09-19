import { useState, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { MAX_CLIPPINGS, PAPER_LOOKS, paperFrames } from '@shared/render/paper'
import { useEditor } from '../store'
import { Slider } from './Slider'

/**
 * The controls for a run of clippings.
 *
 * Everything here is optional on the spec and absent means the preset, so a
 * run nobody has touched is exactly the run that existed before these
 * controls did. That is what keeps a look a look rather than a pile of
 * defaults to keep in step.
 */
export function PaperPanel({ clip }: { clip: Clip }): ReactNode {
  const setPaper = useEditor((s) => s.setPaper)
  const setClipDuration = useEditor((s) => s.setClipDuration)
  const fps = useEditor((s) => s.project.settings.fps)
  const [open, setOpen] = useState(false)
  const paper = clip.paper
  if (!paper) return null

  /*
   * Changing the ripple changes how long it lasts, so the clip follows.
   *
   * Otherwise asking for forty pages plays twenty of them and stops, which
   * looks like the count being ignored rather than like the clip being too
   * short — the failure is in a different place from the control.
   */
  const retime = (patch: Parameters<typeof setPaper>[1]): void => {
    setPaper(clip.id, patch)
    const next = { ...paper, ...patch }
    setClipDuration(clip.id, paperFrames(next) + Math.round(fps * 0.4))
  }

  return (
    <div className="space-y-2 border-t border-ink-850 pt-2">
      <div className="text-[10.5px] text-ink-400">Clippings</div>

      <label className="block">
        <span className="mb-1 block text-[10px] text-ink-600">Highlighted word</span>
        <input
          value={paper.keyword}
          onChange={(e) => setPaper(clip.id, { keyword: e.target.value.toUpperCase() })}
          placeholder="BREAKING"
          className="w-full rounded bg-ink-850 px-2 py-1 text-[11px] text-ink-100 outline-none focus:bg-ink-800"
        />
      </label>

      <div className="grid grid-cols-2 gap-1">
        {PAPER_LOOKS.map((look) => (
          <button
            key={look.id}
            onClick={() => setPaper(clip.id, { lookId: look.id })}
            className={`rounded px-2 py-1.5 text-[10.5px] transition-colors ${
              paper.lookId === look.id
                ? 'bg-flame-500 text-ink-950'
                : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
            }`}
          >
            {look.label}
          </button>
        ))}
      </div>

      {/*
        The ripple. This is the control the effect lives or dies by — a word
        landing on one page is a caption; landing on twenty is the hook.
      */}
      <Slider
        label="Pages"
        value={paper.clippings}
        min={1}
        max={MAX_CLIPPINGS}
        suffix=""
        onChange={(v) => retime({ clippings: Math.round(v) })}
      />
      <Slider
        label="Frames each"
        value={paper.holdFrames}
        min={2}
        max={20}
        suffix=""
        onChange={(v) => retime({ holdFrames: Math.round(v) })}
      />
      <div className="text-[10px] text-ink-600">
        {paperFrames(paper)} frames · {(paperFrames(paper) / fps).toFixed(1)}s
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded bg-ink-850 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-800 hover:text-ink-200"
      >
        {open ? 'Hide' : 'Customise'}
      </button>

      {open && (
        <div className="space-y-2 rounded bg-ink-900/60 p-2">
          <Slider
            label="Size"
            value={Math.round((paper.scale ?? 1) * 100)}
            min={40}
            max={160}
            suffix="%"
            onChange={(v) => setPaper(clip.id, { scale: v / 100 })}
          />
          <Slider
            label="Tilt & tear"
            value={Math.round((paper.distortion ?? 1) * 100)}
            min={0}
            max={300}
            suffix="%"
            onChange={(v) => setPaper(clip.id, { distortion: v / 100 })}
          />
          <Slider
            label="Texture"
            value={Math.round((paper.texture ?? 1) * 100)}
            min={0}
            max={300}
            suffix="%"
            onChange={(v) => setPaper(clip.id, { texture: v / 100 })}
          />

          <label className="block">
            <span className="mb-1 block text-[10px] text-ink-600">
              Your own headline — %s is where the word goes
            </span>
            <input
              value={paper.headline ?? ''}
              onChange={(e) => setPaper(clip.id, { headline: e.target.value })}
              placeholder="Nobody saw %s coming"
              className="w-full rounded bg-ink-850 px-2 py-1 text-[11px] text-ink-100 outline-none focus:bg-ink-800"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-ink-600">Masthead</span>
            <input
              value={paper.masthead ?? ''}
              onChange={(e) => setPaper(clip.id, { masthead: e.target.value })}
              placeholder="THE DAILY CHRONICLE"
              className="w-full rounded bg-ink-850 px-2 py-1 text-[11px] text-ink-100 outline-none focus:bg-ink-800"
            />
          </label>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-600">Marker</span>
            <input
              type="color"
              value={paper.highlight ?? '#ffe14d'}
              onChange={(e) => setPaper(clip.id, { highlight: e.target.value })}
              className="h-6 w-10 rounded border border-ink-700 bg-transparent"
            />
            {/*
              Not a reset for the whole panel — just this one colour back to
              the look's. Clearing everything from a swatch would be a
              surprise, and the look buttons above already do that.
            */}
            <button
              onClick={() => setPaper(clip.id, { highlight: undefined })}
              className="rounded bg-ink-850 px-1.5 py-0.5 text-[10px] text-ink-500 hover:text-ink-200"
            >
              Reset
            </button>
          </div>

          <button
            onClick={() => setPaper(clip.id, { seed: Math.floor(Math.random() * 100000) + 1 })}
            title="A different stack of pages, same settings"
            className="w-full rounded bg-ink-850 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-800 hover:text-ink-200"
          >
            Shuffle the pages
          </button>
        </div>
      )}
    </div>
  )
}
