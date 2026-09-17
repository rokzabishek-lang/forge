import { type ReactNode } from 'react'

/**
 * A labelled slider with its value beside it.
 *
 * Lifted out of the Inspector when the mask panel needed the same control:
 * a second copy is how two panels end up with sliders that look almost but not
 * quite alike, which is exactly the sort of thing that makes an app feel
 * assembled rather than designed.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  /** Defaults to whole numbers, which is what most of these want. */
  step?: number
  suffix: string
  onChange: (value: number) => void
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10.5px] text-ink-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1"
      />
      <span className="w-11 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-500">
        {value}
        {suffix}
      </span>
    </div>
  )
}
