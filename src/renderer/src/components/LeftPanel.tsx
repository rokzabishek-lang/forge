import { useState, type ReactNode } from 'react'
import { useEditor } from '../store'
import { MediaPool } from './MediaPool'
import { Library } from './Library'
import { TranscriptPanel } from './TranscriptPanel'
import { Waveform } from './Waveform'
import { Automation } from './Automation'

type Tab = 'media' | 'library' | 'transcript' | 'auto'

const TABS: { id: Tab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'library', label: 'Library' },
  /*
   * "Transcript", not "Text".
   *
   * This tab shows the spoken words the app heard — it is where captions come
   * from, and it makes no text of its own. Calling it Text put a third thing
   * called Text next to the `+ Text` button and the library's title templates,
   * which is most of why the three felt like the same feature offered three
   * times. Exactly one thing is called Text now, and it is the button that
   * makes a text card.
   */
  { id: 'transcript', label: 'Transcript' },
  { id: 'auto', label: 'Auto' }
]

/**
 * Tabs rather than three stacked panels: at this width a split column gives each
 * section too little height to be usable, and the library in particular needs
 * room to show a grid.
 */
export function LeftPanel(): ReactNode {
  const [tab, setTab] = useState<Tab>('media')
  const addTextClip = useEditor((s) => s.addTextClip)
  const addSolidClip = useEditor((s) => s.addSolidClip)
  const addAdjustmentLayer = useEditor((s) => s.addAdjustmentLayer)
  const playhead = useEditor((s) => s.playhead)
  // Text belongs on top of the picture, so it lands on the highest video track.
  const topVideoTrack = useEditor((s) => {
    const video = s.project.tracks.filter((t) => t.kind === 'video' && !t.locked)
    return video[video.length - 1]?.id ?? ''
  })

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="flex shrink-0 border-b border-ink-800">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={`flex-1 border-b-2 px-2 py-1.5 text-[11px] transition-colors ${
              tab === entry.id
                ? 'border-flame-500 text-ink-200'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'media' && (
          <div className="flex h-full flex-col">
            {/*
              Creating text was impossible before this: titles needed an SVG
              template with placeholders in it, so there was nothing to write a
              word with — and therefore nothing to put behind a subject.
            */}
            <div className="flex shrink-0 gap-1 border-b border-ink-800 p-2">
              <button
                onClick={() => void addTextClip(topVideoTrack, playhead)}
                className="flex-1 rounded bg-ink-800 px-2 py-1 text-[10.5px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
              >
                + Text
              </button>
              <button
                onClick={() => void addSolidClip(topVideoTrack, playhead)}
                title="A flat card of colour — for text to sit on, or as a wash between shots"
                className="flex-1 rounded bg-ink-800 px-2 py-1 text-[10.5px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
              >
                + Colour
              </button>
              <button
                onClick={() => void addAdjustmentLayer(topVideoTrack, playhead)}
                title="Grades everything on the tracks below it, for as long as it runs"
                className="flex-1 rounded bg-ink-800 px-2 py-1 text-[10.5px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
              >
                + Grade
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <MediaPool />
            </div>
          </div>
        )}
        {tab === 'library' && <Library />}
        {tab === 'transcript' && <TranscriptPanel />}
        {tab === 'auto' && <Automation />}
      </div>

      {/* Always visible under the tabs: trimming is a constant activity, and
          hiding it behind a tab would mean losing sight of the thing being
          trimmed while trimming it. */}
      <div className="h-28 shrink-0 border-t border-ink-800 bg-ink-900">
        <Waveform />
      </div>
    </div>
  )
}
