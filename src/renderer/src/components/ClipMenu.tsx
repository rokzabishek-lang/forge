import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import { SPEED_PRESETS, clipSpeed, formatSpeed } from '@shared/render/speed'
import { VOICES } from '@shared/render/voice'
import { useEditor } from '../store'

/**
 * The right-click menu on a clip.
 *
 * There was no context menu anywhere, so every action was reachable only by a
 * keyboard shortcut nobody had been told about, and the two things people
 * actually reach for on a clip — *make this faster* and *make this sound
 * different* — were reachable only by finding the right panel first. A menu is
 * how a shortcut becomes discoverable: it names the gesture, shows its key, and
 * puts the effects one press away from the thing they apply to, which is where
 * CapCut puts them and why people find them there.
 *
 * Positioned where the pointer was, and flipped when that would put it past an
 * edge — a menu with items off the window is a menu with items nobody can click.
 */

export interface ClipMenuTarget {
  clipId: string
  x: number
  y: number
}

const WIDTH = 196
const SUB_WIDTH = 210

function Item({
  label,
  keys,
  onClick,
  danger,
  ticked
}: {
  label: string
  keys?: string
  onClick: () => void
  danger?: boolean
  ticked?: boolean
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-ink-700 ${
        danger ? 'text-red-300 hover:text-red-200' : 'text-ink-200'
      }`}
    >
      <span className="flex items-center gap-1.5">
        {ticked !== undefined && (
          <Check size={11} className={ticked ? 'text-flame-400' : 'opacity-0'} />
        )}
        {label}
      </span>
      {keys && <span className="text-[10px] tabular-nums text-ink-500">{keys}</span>}
    </button>
  )
}

/**
 * A submenu that opens on hover and stays open while the pointer is inside it.
 *
 * Opened on hover rather than on click because these are lists to browse —
 * speeds, voices, looks — and clicking to open a list you are about to click
 * again is one press too many for something used this often.
 */
function Submenu({
  label,
  detail,
  children
}: {
  label: string
  detail?: string
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="relative"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12px] text-ink-200 transition-colors hover:bg-ink-700">
        <span>{label}</span>
        <span className="flex items-center gap-1 text-[10px] text-ink-500">
          {detail}
          <ChevronRight size={12} />
        </span>
      </button>
      {open && (
        <div
          style={{ width: SUB_WIDTH }}
          className="absolute -top-1 left-full z-10 max-h-[320px] overflow-y-auto rounded-md border border-ink-700 bg-ink-800 py-1 shadow-xl shadow-black/40"
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function ClipMenu({
  target,
  onClose
}: {
  target: ClipMenuTarget
  onClose: () => void
}): ReactNode {
  const store = useEditor
  const project = useEditor((s) => s.project)

  /*
   * The built-in looks, which are .cube FILES the main process writes on first
   * use — so the menu asks for the same list the Inspector does rather than
   * reading `LOOKS` directly, whose entries have no file to point a LUT at.
   */
  const [looks, setLooks] = useState<{ id: string; name: string; file: string }[]>([])
  useEffect(() => {
    void window.forge
      .builtInLooks()
      .then(setLooks)
      .catch(() => setLooks([]))
  }, [])

  useEffect(() => {
    // Any click elsewhere, or Escape, closes it. On `pointerdown` rather than
    // `click` so the menu is gone before the thing underneath reacts.
    const away = (): void => onClose()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Handled: closing the menu must not also leave full screen.
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const clip = project.clips.find((c) => c.id === target.clipId)
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined
  const track = clip ? project.tracks.find((t) => t.id === clip.trackId) : undefined
  if (!clip) return null

  /*
   * What this clip can actually be given.
   *
   * A photograph has no rate to change and no sound to retune, so offering
   * either would be a control that cannot do anything — the same reasoning
   * `withClipSpeed` already applies when it refuses a still.
   */
  const hasSound = Boolean(asset?.hasAudio)
  const hasRate = asset?.kind !== 'image'
  const hasPicture = track?.kind === 'video'
  const speed = clipSpeed(clip)

  const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'
  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }

  const left = Math.min(target.x, window.innerWidth - WIDTH - SUB_WIDTH - 12)
  const top = Math.min(target.y, Math.max(8, window.innerHeight - 330))

  return (
    <div
      style={{ left, top, width: WIDTH }}
      // Its own pointerdown must not reach the window listener above, or the
      // menu would close before any item could be chosen.
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-50 rounded-md border border-ink-700 bg-ink-800 py-1 shadow-xl shadow-black/40"
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

      {hasRate && (
        <Submenu label="Speed" detail={formatSpeed(speed)}>
          {SPEED_PRESETS.map((preset) => (
            <Item
              key={preset}
              label={formatSpeed(preset)}
              ticked={Math.abs(speed - preset) < 0.001}
              onClick={run(() => store.getState().setClipSpeed(target.clipId, preset))}
            />
          ))}
          {/*
            Smooth slow invents the in-between frames instead of repeating
            them. Measured at 41x the render time (render/speed.ts), so it is
            offered where the choice is being made rather than turned on
            quietly for anyone who slows a clip down.
          */}
          {speed < 1 && (
            <>
              <div className="my-1 h-px bg-ink-700" />
              <Item
                label="Smooth slow motion"
                ticked={Boolean(clip.smoothSlow)}
                onClick={run(() =>
                  store.getState().setClipSpeed(target.clipId, speed, !clip.smoothSlow)
                )}
              />
            </>
          )}
        </Submenu>
      )}

      {hasSound && (
        <Submenu
          label="Voice"
          detail={VOICES.find((v) => v.id === clip.voice?.id)?.name ?? 'None'}
        >
          <Item
            label="None"
            ticked={!clip.voice}
            onClick={run(() => store.getState().setVoice(target.clipId, null))}
          />
          <div className="my-1 h-px bg-ink-700" />
          {VOICES.map((voice) => (
            <button
              key={voice.id}
              onClick={run(() => store.getState().setVoice(target.clipId, voice.id))}
              className="flex w-full items-start gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-ink-700"
            >
              <Check
                size={11}
                className={`mt-0.5 ${clip.voice?.id === voice.id ? 'text-flame-400' : 'opacity-0'}`}
              />
              <span>
                <span className="block text-[12px] text-ink-200">{voice.name}</span>
                <span className="block text-[10px] leading-tight text-ink-500">{voice.hint}</span>
              </span>
            </button>
          ))}
        </Submenu>
      )}

      {hasPicture && (
        <Submenu label="Look" detail={clip.color.lut?.name ?? 'None'}>
          <Item
            label="None"
            ticked={!clip.color.lut}
            onClick={run(() => store.getState().setColor(target.clipId, { lut: undefined }))}
          />
          <div className="my-1 h-px bg-ink-700" />
          {looks.map((look) => (
            <Item
              key={look.id}
              label={look.name}
              ticked={clip.color.lut?.name === look.name}
              onClick={run(() =>
                store.getState().setColor(target.clipId, {
                  // 0.8, matching the Inspector: a look at full strength is the
                  // commonest way a grade goes wrong.
                  lut: { file: look.file, name: look.name, intensity: 0.8 }
                })
              )}
            />
          ))}
        </Submenu>
      )}

      <div className="my-1 h-px bg-ink-700" />

      <Item label="Split here" keys="S" onClick={run(() => store.getState().splitAtPlayhead())} />
      {/*
        Detach audio — the other half of what A5 left out of this menu until
        it existed. Offered only where it means something: a picture that has
        sound of its own, on a video track.
      */}
      {hasPicture && hasSound && !clip.audioDetached && (
        <Item
          label="Detach audio"
          onClick={run(() => store.getState().detachAudio(target.clipId))}
        />
      )}
      {clip.audioDetached && (
        <Item
          label="Restore its own sound"
          onClick={run(() => store.getState().reattachAudio(target.clipId))}
        />
      )}
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
