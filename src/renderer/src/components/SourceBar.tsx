import { useState, type ReactNode } from 'react'
import { Clapperboard, DownloadCloud, Loader2, Upload } from 'lucide-react'
import { useEditor, type SourceMode } from '../store'

/**
 * Where material comes from.
 *
 * Three ways in, not five. The sketch listed mp4, mp3 and instrumental as
 * siblings of the YouTube entry, but they are not alternatives to it — they are
 * what you choose AFTER pasting a link, along with the quality. Modelling them
 * as top-level tabs would make four of five lead to the same screen.
 *
 * Only the first is built. The other two say what they will do rather than
 * pretending: an entry point that quietly does nothing is the thing that made
 * half this app feel broken.
 */

const MODES: {
  id: SourceMode
  label: string
  icon: typeof Upload
  hint: string
  soon?: string
}[] = [
  {
    id: 'upload',
    label: 'Upload',
    icon: Upload,
    hint: 'Photos, video and music from this machine'
  },
  {
    id: 'youtube',
    label: 'YouTube',
    icon: DownloadCloud,
    hint: 'Paste a link, choose the quality, take the video or just the audio',
    soon: 'Paste a link → pick 4K/1080/720/480 → video, audio, or the instrumental.'
  },
  {
    id: 'narration',
    label: 'Narration',
    icon: Clapperboard,
    hint: 'Give a topic; the edit is written and assembled for you',
    soon: 'Topic and length in, narration and a cut out. The only part of the app that needs paid services.'
  }
]

export function SourceBar(): ReactNode {
  const sourceMode = useEditor((s) => s.sourceMode)
  const setSourceMode = useEditor((s) => s.setSourceMode)
  const importAssets = useEditor((s) => s.importAssets)
  const [busy, setBusy] = useState(false)

  const current = MODES.find((m) => m.id === sourceMode) ?? MODES[0]

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const paths = await window.forge.pickMedia()
      if (paths.length > 0) await importAssets(paths)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-ink-850 bg-ink-900">
      <div className="flex items-center gap-1 px-2 py-1.5">
        {MODES.map((mode) => {
          const Icon = mode.icon
          const on = mode.id === sourceMode
          return (
            <button
              key={mode.id}
              onClick={() => setSourceMode(mode.id)}
              title={mode.hint}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                on
                  ? 'bg-ink-800 text-ink-200'
                  : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200'
              }`}
            >
              <Icon size={12} strokeWidth={1.8} className={mode.soon ? 'opacity-60' : undefined} />
              {mode.label}
              {mode.soon && <span className="text-[9px] text-ink-600">soon</span>}
            </button>
          )
        })}

        <div className="ml-auto">
          {sourceMode === 'upload' ? (
            <button
              onClick={() => void pick()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-flame-500 px-3 py-1 text-[11px] font-medium text-ink-950 transition-colors hover:bg-flame-400 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              Add files
            </button>
          ) : (
            <span className="pr-1 text-[10px] text-ink-600">not built yet</span>
          )}
        </div>
      </div>

      {current.soon && (
        <div className="border-t border-ink-850 px-3 py-1.5 text-[10.5px] leading-snug text-ink-600">
          {current.soon}
        </div>
      )}
    </div>
  )
}
