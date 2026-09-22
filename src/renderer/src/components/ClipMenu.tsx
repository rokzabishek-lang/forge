import { useEffect, useRef, type ReactNode } from 'react'
import { useEditor } from '../store'

/**
 * The right-click menu on a clip.
 *
 * There was no context menu anywhere, so every one of these actions was
 * reachable only by a keyboard shortcut nobody had been told about. A menu is
 * how a shortcut becomes discoverable: it names the gesture and shows its key
 * beside it, which is the only place most people ever learn one.
 *
 * Positioned where the pointer was and flipped when that would put it off the
 * bottom or the right — a menu that opens past the edge of the window is a
 * menu with items nobody can click.
 */

export interface ClipMenuTarget {
  clipId: string
  x: number
  y: number
}

const WIDTH = 188

function Item({
  label,
  keys,
  onClick,
  danger
}: {
  label: string
  keys?: string
  onClick: () => void
  danger?: boolean
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-ink-700 ${
        danger ? 'text-red-300 hover:text-red-200' : 'text-ink-200'
      }`}
    >
      <span>{label}</span>
      {keys && <span className="text-[10px] tabular-nums text-ink-500">{keys}</span>}
    </button>
  )
}

export function ClipMenu({
  target,
  onClose
}: {
  target: ClipMenuTarget
  onClose: () => void
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  const store = useEditor

  useEffect(() => {
    // Any click anywhere else, or Escape, closes it. On `pointerdown` rather
    // than `click` so the menu is gone before the thing underneath reacts.
    const away = (): void => onClose()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'
  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }

  // Flipped rather than clamped: an item under the pointer would be clicked by
  // the same press that opened the menu.
  const left = Math.min(target.x, window.innerWidth - WIDTH - 8)
  const top = Math.min(target.y, window.innerHeight - 260)

  return (
    <div
      ref={box}
      style={{ left, top, width: WIDTH }}
      // The menu's own pointerdown must not reach the window listener above,
      // or it would close before any item could be chosen.
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-50 overflow-hidden rounded-md border border-ink-700 bg-ink-800 py-1 shadow-xl shadow-black/40"
    >
      <Item label="Cut" keys={`${mod}X`} onClick={run(() => store.getState().cutSelection())} />
      <Item label="Copy" keys={`${mod}C`} onClick={run(() => store.getState().copySelection())} />
      <Item
        label="Duplicate"
        keys={`${mod}D`}
        onClick={run(() => void store.getState().duplicateSelection())}
      />
      <Item
        label="Paste"
        keys={`${mod}V`}
        onClick={run(() => void store.getState().pasteClipboard())}
      />

      <div className="my-1 h-px bg-ink-700" />

      <Item label="Split here" keys="S" onClick={run(() => store.getState().splitAtPlayhead())} />
      {/*
        FIX.md also lists "Reveal in pool" and "Detach audio". The pool has no
        selection state for anything to be revealed INTO — that is a feature of
        its own, not a menu item — and detaching audio is B1. Neither is faked
        here: a menu item that does nothing is worse than one that is absent.
      */}
      <Item label="Select all" keys={`${mod}A`} onClick={run(() => store.getState().selectAll())} />

      <div className="my-1 h-px bg-ink-700" />

      <Item label="Delete" keys="⌫" danger onClick={run(() => store.getState().deleteSelection())} />
      <Item
        label="Ripple delete"
        keys="⇧⌫"
        danger
        onClick={run(() => store.getState().rippleDeleteSelection())}
      />
    </div>
  )
}
