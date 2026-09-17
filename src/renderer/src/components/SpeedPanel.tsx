import { type ReactNode } from 'react'
import type { Clip, MediaAsset } from '@shared/timeline'
import {
  MAX_SPEED,
  MIN_SPEED,
  SPEED_PRESETS,
  clipSpeed,
  formatSpeed
} from '@shared/render/speed'
import { useEditor } from '../store'
import { Slider } from './Slider'

/**
 * Speed.
 *
 * A held beat in slow motion and a whip through the dull part are the two edits
 * that most reliably decide whether a reel plays or gets scrolled past, so the
 * presets come first and the slider second — reaching for "half speed" should
 * be one click, not a hunt along a track.
 *
 * The clip keeps its footage and changes its length, which is what everyone
 * means by a speed control. The panel says the new length out loud, because the
 * timeline moving underneath you is otherwise the surprising part.
 */
export function SpeedPanel({ clip, asset }: { clip: Clip; asset: MediaAsset | null }): ReactNode {
  const setClipSpeed = useEditor((s) => s.setClipSpeed)
  const fps = useEditor((s) => s.project.settings.fps)

  // A photograph has no rate to change; its length is just its length.
  if (!asset || asset.kind === 'image') return null

  const speed = clipSpeed(clip)
  const normal = Math.abs(speed - 1) < 0.001
  const seconds = (clip.duration / fps).toFixed(2)


  return (
    <div className="space-y-1.5 border-t border-ink-850 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Speed</span>
        <span className="font-mono text-[10px] tabular-nums text-ink-500">
          {formatSpeed(speed)} · {seconds}s
        </span>
      </div>

      <div className="flex items-center gap-0.5">
        {/*
         * Every preset is always available.
         *
         * An earlier version greyed out the fast ones when it judged there was
         * "not enough footage left", which was simply wrong: speeding up never
         * runs out of anything, it just makes the clip shorter. The harness
         * caught it immediately — at quarter speed the 2x button was dead, so
         * there was no way back out of slow motion except the reset. Running
         * past the end of the media is already handled where it belongs, by
         * durationAtSpeed clamping the length.
         */}
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            onClick={() => setClipSpeed(clip.id, preset, clip.smoothSlow)}
            title={`${formatSpeed(preset)} — the clip keeps the same footage and changes length`}
            className={`flex-1 rounded px-1 py-0.5 text-[10px] transition-colors ${
              Math.abs(speed - preset) < 0.001
                ? 'bg-ink-800 text-ink-100'
                : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
            }`}
          >
            {formatSpeed(preset)}
          </button>
        ))}
      </div>

      <Slider
        label="Rate"
        value={Math.round(speed * 100)}
        min={Math.round(MIN_SPEED * 100)}
        max={Math.round(MAX_SPEED * 100)}
        step={5}
        suffix="%"
        onChange={(v) => setClipSpeed(clip.id, v / 100, clip.smoothSlow)}
      />

      {speed < 1 && (
        <button
          onClick={() => setClipSpeed(clip.id, speed, !clip.smoothSlow)}
          title={
            'Invents the in-between frames instead of repeating them. Measured at ' +
            '1080x1920 it made the render 41 times slower, so it is worth it for a ' +
            'hero shot and not for a whole reel.'
          }
          className={`w-full rounded px-1.5 py-1 text-left text-[10px] transition-colors ${
            clip.smoothSlow
              ? 'bg-ink-800 text-ink-100'
              : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
          }`}
        >
          {clip.smoothSlow ? 'Smooth — inventing frames' : 'Smooth slow motion'}
          <span className="ml-1 text-ink-600">{clip.smoothSlow ? '· slow to export' : ''}</span>
        </button>
      )}

      {!normal && (
        <button
          onClick={() => setClipSpeed(clip.id, 1)}
          className="w-full rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-300"
        >
          Back to normal speed
        </button>
      )}

      <p className="text-[9.5px] leading-snug text-ink-600">
        The clip keeps the same footage and changes how long it sits on the timeline. Anything
        after it on this track moves along with it.
      </p>
    </div>
  )
}
