import type { ReactNode } from 'react'
import { Check, Pause, Play, Repeat, Scissors, SkipBack, SkipForward, Trash2, Volume2, ZoomIn, ZoomOut } from 'lucide-react'
import { formatTimecode, projectDuration } from '@shared/timeline'
import { useEditor } from '../store'

function Button({
  onClick,
  title,
  children
}: {
  onClick: () => void
  title: string
  children: ReactNode
}): ReactNode {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
    >
      {children}
    </button>
  )
}

export function Transport(): ReactNode {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const zoom = useEditor((s) => s.zoom)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setZoom = useEditor((s) => s.setZoom)
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead)
  const loop = useEditor((s) => s.loop)
  const setLoop = useEditor((s) => s.setLoop)
  const scrubAudio = useEditor((s) => s.scrubAudio)
  const setScrubAudio = useEditor((s) => s.setScrubAudio)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const removeClip = useEditor((s) => s.removeClip)

  const fps = project.settings.fps
  const total = projectDuration(project)

  return (
    <div className="flex items-center gap-1 border-t border-ink-800 bg-ink-900 px-3 py-1.5">
      <Button onClick={() => setPlayhead(0)} title="Go to start (Home)">
        <SkipBack size={14} />
      </Button>
      <Button onClick={() => setPlaying(!playing)} title="Play / pause (Space)">
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </Button>
      <Button onClick={() => setPlayhead(total)} title="Go to end (End)">
        <SkipForward size={14} />
      </Button>

      {/* A labelled checkbox, not a bare icon: an unlabelled glyph in a row of
          transport buttons is not discoverable. */}
      <label
        className="ml-1 flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-1 hover:bg-ink-800"
        title={loop ? 'Looping — playback restarts at the end' : 'Plays once and stops at the end'}
      >
        <span
          className={`flex size-3.5 items-center justify-center rounded-[3px] border transition-colors ${
            loop ? 'border-flame-500 bg-flame-500' : 'border-ink-600 bg-transparent'
          }`}
        >
          {loop && <Check size={10} strokeWidth={3} className="text-ink-950" />}
        </span>
        <input
          type="checkbox"
          checked={loop}
          onChange={(e) => setLoop(e.target.checked)}
          className="sr-only"
        />
        <Repeat size={12} className={loop ? 'text-flame-400' : 'text-ink-400'} />
        <span className={`text-[11px] ${loop ? 'text-flame-400' : 'text-ink-400'}`}>Loop</span>
      </label>

      {/* Scrub audio, beside Loop because both are "how playback behaves"
          rather than actions. On by default: finding a beat is done by ear. */}
      <label
        className="flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-1 hover:bg-ink-800"
        title={
          scrubAudio
            ? 'Hearing the sound while you drag the playhead'
            : 'Silent while you drag the playhead'
        }
      >
        <span
          className={`flex size-3.5 items-center justify-center rounded-[3px] border transition-colors ${
            scrubAudio ? 'border-flame-500 bg-flame-500' : 'border-ink-600 bg-transparent'
          }`}
        >
          {scrubAudio && <Check size={10} strokeWidth={3} className="text-ink-950" />}
        </span>
        <input
          type="checkbox"
          checked={scrubAudio}
          onChange={(e) => setScrubAudio(e.target.checked)}
          className="sr-only"
        />
        <Volume2 size={12} className={scrubAudio ? 'text-flame-400' : 'text-ink-400'} />
        <span className={`text-[11px] ${scrubAudio ? 'text-flame-400' : 'text-ink-400'}`}>
          Scrub
        </span>
      </label>

      <div className="mx-2 h-4 w-px bg-ink-700" />

      <Button onClick={splitAtPlayhead} title="Split at playhead (S)">
        <Scissors size={14} />
      </Button>

      <button
        onClick={() => selectedClipId && removeClip(selectedClipId)}
        disabled={!selectedClipId}
        title={selectedClipId ? 'Remove the selected clip (Delete)' : 'Select a clip to remove it'}
        className="rounded p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-red-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-400"
      >
        <Trash2 size={14} />
      </button>

      <div className="mx-3 font-mono text-[12px] tabular-nums text-ink-200">
        {formatTimecode(playhead, fps)}
        <span className="ml-2 text-ink-600">/ {formatTimecode(total, fps)}</span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Button onClick={() => setZoom(zoom / 1.4)} title="Zoom out">
          <ZoomOut size={14} />
        </Button>
        <Button onClick={() => setZoom(zoom * 1.4)} title="Zoom in">
          <ZoomIn size={14} />
        </Button>
      </div>
    </div>
  )
}
