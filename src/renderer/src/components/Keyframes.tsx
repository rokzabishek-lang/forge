import { type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import {
  KEYED_PROPERTIES,
  PROPERTY_INFO,
  normaliseKeys,
  valueAt,
  type Ease,
  type KeyedProperty
} from '@shared/render/keyframes'
import { useEditor } from '../store'

/**
 * Keyframes, per property.
 *
 * The shape every NLE uses: a row per property with a key button that lights up
 * when the playhead is sitting on one. Setting a value while the playhead is
 * between keys writes a new key there, which is what makes the whole thing feel
 * like animating rather than like editing a list.
 */
export function Keyframes({ clip }: { clip: Clip }): ReactNode {
  const playhead = useEditor((s) => s.playhead)
  const setKeyframe = useEditor((s) => s.setKeyframe)
  const removeKeyframe = useEditor((s) => s.removeKeyframe)
  const clearKeyframes = useEditor((s) => s.clearKeyframes)
  const setPlayhead = useEditor((s) => s.setPlayhead)

  // Where the playhead is inside this clip. Outside it, keys would land at the
  // ends and read as if the button did nothing.
  const into = Math.round(playhead - clip.start)
  const inside = into >= 0 && into <= clip.duration

  return (
    <div className="space-y-1.5 border-t border-ink-850 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Keyframes</span>
        {!inside && (
          <span className="text-[10px] text-ink-600">playhead is off this clip</span>
        )}
      </div>

      {KEYED_PROPERTIES.map((property) => {
        const info = PROPERTY_INFO[property]
        const keys = normaliseKeys(clip.keyframes?.[property] ?? [], clip.duration)
        const onKey = keys.find((k) => k.frame === into) ?? null
        const current = valueAt(keys, into, clip.duration, info.neutral)

        return (
          <div key={property} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  onKey
                    ? removeKeyframe(clip.id, property, into)
                    : setKeyframe(clip.id, property, into, current)
                }
                disabled={!inside}
                title={
                  onKey
                    ? 'Remove the key at the playhead'
                    : 'Add a key at the playhead, holding the value it has now'
                }
                className={`h-4 w-4 shrink-0 rotate-45 rounded-[2px] border transition-colors disabled:opacity-25 ${
                  onKey
                    ? 'border-flame-400 bg-flame-500'
                    : keys.length > 0
                      ? 'border-flame-500/60 bg-transparent hover:bg-flame-500/30'
                      : 'border-ink-600 bg-transparent hover:border-flame-500'
                }`}
              />
              <span className="w-14 shrink-0 text-[10.5px] text-ink-400">{info.label}</span>
              <input
                type="range"
                min={info.min}
                max={info.max}
                step={info.step}
                value={current}
                disabled={!inside}
                /*
                 * Dragging writes a key at the playhead rather than a static
                 * value. Once a property is animated there is no such thing as
                 * "the value" — only the value here.
                 */
                onChange={(e) => setKeyframe(clip.id, property, into, Number(e.target.value))}
                className="min-w-0 flex-1 disabled:opacity-30"
              />
              <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-500">
                {format(current, property)}
                {info.suffix}
              </span>
            </div>

            {keys.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 pl-6">
                {keys.map((key) => (
                  <button
                    key={key.frame}
                    onClick={() => setPlayhead(clip.start + key.frame)}
                    onDoubleClick={() => removeKeyframe(clip.id, property, key.frame)}
                    title={`Frame ${key.frame} — click to jump, double-click to remove`}
                    className={`rounded px-1 py-0.5 font-mono text-[9px] tabular-nums ${
                      key.frame === into
                        ? 'bg-flame-500 text-ink-950'
                        : 'bg-ink-800 text-ink-500 hover:bg-ink-700 hover:text-ink-300'
                    }`}
                  >
                    {key.frame}
                  </button>
                ))}
                <select
                  value={onKey?.ease ?? 'linear'}
                  disabled={!onKey}
                  onChange={(e) =>
                    setKeyframe(clip.id, property, into, current, e.target.value as Ease)
                  }
                  title="How the value leaves this key"
                  className="rounded bg-ink-800 px-1 py-0.5 text-[9px] text-ink-400 outline-none disabled:opacity-30"
                >
                  <option value="linear">linear</option>
                  <option value="smooth">smooth</option>
                  <option value="hold">hold</option>
                </select>
                <button
                  onClick={() => clearKeyframes(clip.id, property)}
                  title={`Remove every ${info.label.toLowerCase()} key`}
                  className="ml-auto rounded px-1 py-0.5 text-[9px] text-ink-600 hover:bg-ink-800 hover:text-ink-300"
                >
                  clear
                </button>
              </div>
            )}
          </div>
        )
      })}

      <p className="text-[10px] leading-snug text-ink-600">
        One key is a value; two or more animate. Zoom punches into the picture rather than
        resizing the box — ffmpeg cannot animate a scale, so offering one would be offering
        something that does not export.
      </p>
    </div>
  )
}

function format(value: number, property: KeyedProperty): string {
  return property === 'rotation' ? String(Math.round(value)) : value.toFixed(2)
}
