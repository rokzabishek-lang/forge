import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * The keyboard, written down.
 *
 * Every one of these already worked and none of them was discoverable: there
 * was no menu, no help, and no list — so the only way to learn that ⇧Delete
 * ripples or that Alt+arrow nudges was to be told. An editor is driven by the
 * keyboard, and a keyboard nobody can see is a feature nobody has.
 *
 * Grouped by what you are doing rather than alphabetically, because the
 * question people arrive with is "how do I move this", not "what does D do".
 */

const MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
const MOD = MAC ? '⌘' : 'Ctrl'
const ALT = MAC ? '⌥' : 'Alt'

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Playing',
    keys: [
      ['Space', 'Play / pause'],
      ['← →', 'One frame'],
      [`${MOD}← ${MOD}→`, 'One second'],
      ['Home / End', 'Start / end'],
      ['I / O', 'Mark in / mark out'],
      [`${ALT}X`, 'Clear the marked range']
    ]
  },
  {
    title: 'Selecting',
    keys: [
      ['Click', 'Select a clip'],
      [`⇧ or ${MOD} click`, 'Add to the selection'],
      ['Drag on empty lane', 'Marquee'],
      [`${MOD}A`, 'Select all'],
      ['Click a gap', 'Select the gap']
    ]
  },
  {
    title: 'Editing',
    keys: [
      ['S', 'Split at the playhead'],
      [`${ALT}← ${ALT}→`, 'Nudge one frame'],
      [`⇧${ALT}← ⇧${ALT}→`, 'Nudge ten frames'],
      [`${MOD}X / ${MOD}C / ${MOD}V`, 'Cut / copy / paste'],
      [`${MOD}D`, 'Duplicate'],
      ['Delete', 'Delete, leaving the gap'],
      ['⇧Delete', 'Ripple delete, closing it'],
      ['Right-click', 'Speed, voice, look and the rest']
    ]
  },
  {
    title: 'The project',
    keys: [
      [`${MOD}Z / ${MOD}⇧Z`, 'Undo / redo'],
      [`${MOD}S`, 'Save'],
      [`${MOD}⇧S`, 'Save As'],
      [`${MOD}O`, 'Open'],
      [`${MOD}E`, 'Export'],
      ['⇧Z', 'Fit the whole project'],
      [`${MOD}/`, 'This list']
    ]
  }
]

export function Shortcuts({ onClose }: { onClose: () => void }): ReactNode {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Handled: closing this sheet must not also leave full screen.
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  return (
    <div
      // Click anywhere off the sheet to close it, which is what every sheet
      // like this does and what people try first.
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/70 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-full max-w-3xl overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-100">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-200"
          >
            <X size={15} />
          </button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-ink-600">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.keys.map(([key, what]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4">
                    <span className="text-[12px] text-ink-300">{what}</span>
                    <kbd className="shrink-0 rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
