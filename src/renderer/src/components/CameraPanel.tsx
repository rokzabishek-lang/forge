import { type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minimize2, Maximize2, MoveHorizontal } from 'lucide-react'
import type { Clip, MotionMove } from '@shared/timeline'
import { DEFAULT_SHAKE_DECAY, DEFAULT_SHAKE_HZ, MAX_PARALLAX_AMOUNT } from '@shared/render/motion'
import { SHAKE_DECAY_RANGE, SHAKE_HZ_RANGE, depthFor } from '@shared/edit/camera'
import { useEditor } from '../store'
import { Slider } from './Slider'

/**
 * A camera move on a photograph, set by hand (FIX.md B3).
 *
 * The automations have always put these on — a slow push-in, a drift, a hit
 * of shake on a beat — and there was no way to choose one, change one or take
 * one off. The moves and their arithmetic are render/motion.ts, shared by the
 * preview and the export; this only chooses between them.
 */

type Kind = 'none' | 'kenburns' | 'shake' | 'parallax'

const ROWS: { label: string; moves: { id: MotionMove; title: string; icon: typeof ArrowLeft }[] }[] = [
  {
    label: 'In',
    moves: [
      { id: 'in', title: 'Push in, centred', icon: Maximize2 },
      { id: 'inLeft', title: 'Push in, drifting left', icon: ArrowLeft },
      { id: 'inRight', title: 'Push in, drifting right', icon: ArrowRight },
      { id: 'inUp', title: 'Push in, drifting up', icon: ArrowUp },
      { id: 'inDown', title: 'Push in, drifting down', icon: ArrowDown }
    ]
  },
  {
    label: 'Out',
    moves: [
      { id: 'out', title: 'Pull out, centred', icon: Minimize2 },
      { id: 'outLeft', title: 'Pull out, drifting left', icon: ArrowLeft },
      { id: 'outRight', title: 'Pull out, drifting right', icon: ArrowRight }
    ]
  },
  {
    label: 'Pan',
    moves: [
      { id: 'panLeft', title: 'Pan left', icon: ArrowLeft },
      { id: 'panRight', title: 'Pan right', icon: ArrowRight },
      { id: 'panUp', title: 'Pan up', icon: ArrowUp },
      { id: 'panDown', title: 'Pan down', icon: ArrowDown }
    ]
  }
]

export function CameraPanel({ clip }: { clip: Clip }): ReactNode {
  const setMotion = useEditor((s) => s.setMotion)
  const project = useEditor((s) => s.project)
  const depth = depthFor(project, clip.assetId)
  const motion = clip.motion
  const kind: Kind = motion?.kind ?? 'none'
  const direction: MotionMove = motion && motion.kind !== 'shake' ? motion.direction : 'in'
  const amount = motion?.amount ?? 0.15
  const zoomKeyed = (clip.keyframes?.zoom?.length ?? 0) > 0

  const kinds: { id: Kind; label: string; title: string }[] = [
    { id: 'none', label: 'None', title: 'No camera move' },
    { id: 'kenburns', label: 'Move', title: 'A slow push, pull or pan across the photo' },
    { id: 'shake', label: 'Shake', title: 'A hit of camera shake that settles — for a beat or a drop' },
    ...(depth.planes
      ? [{ id: 'parallax' as const, label: 'Depth', title: 'The same move on the photo’s depth planes: near things travel further' }]
      : [])
  ]

  const choose = (next: Kind): void => {
    if (next === 'none') setMotion(clip.id, undefined)
    else if (next === 'shake') setMotion(clip.id, { kind: 'shake', amount: Math.min(amount, 0.2), hz: DEFAULT_SHAKE_HZ, decay: DEFAULT_SHAKE_DECAY })
    else setMotion(clip.id, { kind: next, direction, amount: next === 'parallax' ? Math.min(amount, MAX_PARALLAX_AMOUNT) : amount })
  }

  return (
    <div className="space-y-1.5 border-t border-ink-850 pt-2">
      <span className="text-[10.5px] text-ink-400">Camera</span>
      <div className="flex items-center gap-0.5">
        {kinds.map((k) => (
          <button
            key={k.id}
            onClick={() => choose(k.id)}
            title={k.title}
            className={`flex-1 rounded px-1 py-0.5 text-[10px] transition-colors ${
              kind === k.id ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {motion && motion.kind !== 'shake' && (
        <div className="space-y-0.5">
          {ROWS.map((row) => (
            <div key={row.label} className="flex items-center gap-0.5">
              <span className="w-8 shrink-0 text-[9.5px] text-ink-600">{row.label}</span>
              {row.moves.map(({ id, title, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setMotion(clip.id, { ...motion, direction: id })}
                  title={title}
                  className={`flex h-5 w-6 items-center justify-center rounded transition-colors ${
                    direction === id ? 'bg-flame-500 text-ink-950' : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
                  }`}
                >
                  <Icon size={11} strokeWidth={2} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {motion && (
        <Slider
          label="Amount"
          value={Math.round(motion.amount * 100)}
          min={1}
          max={motion.kind === 'parallax' ? Math.floor(MAX_PARALLAX_AMOUNT * 100) : 50}
          suffix="%"
          onChange={(v) => setMotion(clip.id, { ...motion, amount: v / 100 })}
        />
      )}

      {motion?.kind === 'shake' && (
        <>
          <Slider
            label="Rate"
            value={Math.round(motion.hz ?? DEFAULT_SHAKE_HZ)}
            min={SHAKE_HZ_RANGE.min}
            max={SHAKE_HZ_RANGE.max}
            suffix="Hz"
            onChange={(v) => setMotion(clip.id, { ...motion, hz: v })}
          />
          <Slider
            label="Settle"
            value={Math.round((motion.decay ?? DEFAULT_SHAKE_DECAY) * 100)}
            min={Math.round(SHAKE_DECAY_RANGE.min * 100)}
            max={Math.round(SHAKE_DECAY_RANGE.max * 100)}
            suffix=""
            display={(motion.decay ?? DEFAULT_SHAKE_DECAY) === 0 ? 'never' : `${(motion.decay ?? DEFAULT_SHAKE_DECAY).toFixed(2)}s`}
            onChange={(v) => setMotion(clip.id, { ...motion, decay: v / 100 })}
          />
          {depth.subject && (
            <div className="flex items-center gap-0.5">
              <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Hold</span>
              {(['camera', 'subject'] as const).map((anchor) => (
                <button
                  key={anchor}
                  onClick={() => setMotion(clip.id, { ...motion, anchor })}
                  title={anchor === 'subject' ? 'Shake the world and hold the person still' : 'Shake the whole picture'}
                  className={`flex-1 rounded px-1 py-0.5 text-[10px] transition-colors ${
                    (motion.anchor ?? 'camera') === anchor ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
                  }`}
                >
                  {anchor === 'subject' ? 'Subject still' : 'Whole picture'}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {motion?.window && (
        <p className="flex items-start gap-1 text-[9.5px] leading-snug text-ink-600">
          <MoveHorizontal size={11} className="mt-px shrink-0" />
          {motion.window.from > 0
            ? 'Carries on a move from the clip before it — they were one clip, split.'
            : 'Its move carries on into the clip after it — they were one clip, split.'}{' '}
          Changing it here makes it this clip’s own.
        </p>
      )}
      <p className="text-[9.5px] leading-snug text-ink-600">
        {zoomKeyed && !motion
          ? 'This photo has Zoom keyframes — choosing a move takes them off, since both scale the picture.'
          : 'A move and Zoom keyframes both scale the picture, so choosing one takes the other off.'}
      </p>
    </div>
  )
}
