import { useState, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import {
  MAX_CLIPPINGS,
  PAPER_LOOKS,
  PAPER_SHAPES,
  clippingCount,
  paperFrames
} from '@shared/render/paper'
import { useEditor } from '../store'
import { paperDuration } from '../paperCanvas'
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
    // `paperDuration`, not a second copy of the arithmetic. The creator and
    // this panel disagreeing by a few frames is a clip whose last page is
    // clipped or held, depending on which one ran last.
    setClipDuration(clip.id, paperDuration({ ...paper, ...patch }, fps))
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

      {/*
        Mode first: a page and a scattering of cut-out letters are different
        effects, and half the controls below only apply to one of them.
      */}
      <div className="grid grid-cols-2 gap-1">
        {([
          ['page', 'Clipping'],
          ['letters', 'Cut-out letters']
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPaper(clip.id, { mode: id })}
            className={`rounded px-2 py-1.5 text-[10.5px] transition-colors ${
              (paper.mode ?? 'page') === id
                ? 'bg-flame-500 text-ink-950'
                : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        Shape before look, because it is the bigger decision: a full page and
        a torn strip are different objects, and the look is paint on top.
        Meaningless for cut-out letters, which have no page to shape.
      */}
      {(paper.mode ?? 'page') === 'page' && (
      <div className="grid grid-cols-3 gap-1">
        {PAPER_SHAPES.map((s) => (
          <button
            key={s.id}
            onClick={() => setPaper(clip.id, { shape: s.id })}
            className={`rounded px-1 py-1.5 text-[10px] transition-colors ${
              (paper.shape ?? 'clip') === s.id
                ? 'bg-flame-500 text-ink-950'
                : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      )}

      {/*
        Typing only means something on a page — cut-out letters already
        arrive one at a time, which is their whole animation.
      */}
      {(paper.mode ?? 'page') === 'page' && (
        <button
          onClick={() =>
            setPaper(clip.id, { reveal: paper.reveal === 'type' ? 'none' : 'type' })
          }
          title="Reveal the headline a character at a time, with a caret — the marker waits until the word is actually there"
          className={`w-full rounded px-2 py-1.5 text-[10.5px] transition-colors ${
            paper.reveal === 'type'
              ? 'bg-flame-500 text-ink-950'
              : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
          }`}
        >
          Typewriter {paper.reveal === 'type' ? 'on' : 'off'}
        </button>
      )}

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
      {/*
        Each page's own time on screen, in seconds as well as frames.
        Frames are what the timeline works in; seconds are what anyone
        deciding "how long should each one hold" actually thinks in.
      */}
      <Slider
        label="Each page"
        value={paper.holdFrames}
        min={1}
        max={30}
        suffix={` fr · ${(paper.holdFrames / fps).toFixed(2)}s`}
        onChange={(v) => retime({ holdFrames: Math.round(v) })}
      />
      <div className="text-[10px] text-ink-600">
        {clippingCount(paper)} pages · {paperFrames(paper)} frames ·{' '}
        {(paperFrames(paper) / fps).toFixed(1)}s total
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
