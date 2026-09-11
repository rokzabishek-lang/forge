import { useState, type ReactNode } from 'react'
import { MediaPool } from './MediaPool'
import { Library } from './Library'
import { TranscriptPanel } from './TranscriptPanel'
import { Waveform } from './Waveform'

type Tab = 'media' | 'library' | 'transcript'

const TABS: { id: Tab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'library', label: 'Library' },
  { id: 'transcript', label: 'Transcript' }
]

/**
 * Tabs rather than three stacked panels: at this width a split column gives each
 * section too little height to be usable, and the library in particular needs
 * room to show a grid.
 */
export function LeftPanel(): ReactNode {
  const [tab, setTab] = useState<Tab>('media')

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
        {tab === 'media' && <MediaPool />}
        {tab === 'library' && <Library />}
        {tab === 'transcript' && <TranscriptPanel />}
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
