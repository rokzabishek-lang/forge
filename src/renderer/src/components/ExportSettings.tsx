import { useEffect, type ReactNode } from 'react'
import {
  AUDIO_KBPS,
  BITRATE_RANGE,
  FALLBACK_ENCODER,
  QUALITY_PRESETS,
  bitrateForCrf,
  encoderInfo,
  offeredEncoders,
  type SpeedPreset
} from '@shared/render/encode'
import { RESOLUTIONS, exportCanvas } from '@shared/render/exportShape'
import { formatTimecode } from '@shared/timeline'
import type { AspectKey } from '@shared/render/aspect'
import { useEditor } from '../store'

/**
 * How the file is made: size, codec, quality, audio, container, and how much
 * of the edit.
 *
 * Everything here was one fixed block in the render — 1080-class H.264 at CRF
 * 20, AAC 192k, MP4, the whole timeline — so a client asking for ProRes, a
 * platform asking for 8 Mbps, or someone wanting only the bit between the marks
 * had no answer. See docs/FIX.md B2.
 *
 * Only encoders that actually WORK here are offered. `-encoders` listing one is
 * not evidence — the bundled macOS build lists VideoToolbox and then fails to
 * open it — so each is test-encoded once per launch with the export's own
 * arguments (main/render/encoders.ts), and the list below is that answer.
 */

const SPEEDS: { id: SpeedPreset; label: string }[] = [
  { id: 'veryfast', label: 'Fastest' },
  { id: 'fast', label: 'Fast' },
  { id: 'medium', label: 'Balanced' },
  { id: 'slow', label: 'Smallest' }
]

const segment = (on: boolean): string =>
  `rounded px-2 py-1.5 text-[11px] transition-colors disabled:opacity-30 ${
    on ? 'bg-flame-500 text-ink-950' : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
  }`

export function ExportSettings({
  aspect,
  useRange,
  setUseRange
}: {
  aspect: AspectKey
  useRange: boolean
  setUseRange: (on: boolean) => void
}): ReactNode {
  const choice = useEditor((s) => s.exportChoice)
  const setChoice = useEditor((s) => s.setExportChoice)
  const encoders = useEditor((s) => s.encoders)
  const loadEncoders = useEditor((s) => s.loadEncoders)
  const rangeIn = useEditor((s) => s.rangeIn)
  const rangeOut = useEditor((s) => s.rangeOut)
  const fps = useEditor((s) => s.project.settings.fps)

  useEffect(() => {
    void loadEncoders()
  }, [loadEncoders])

  const working = offeredEncoders(encoders)
  // A stored choice this machine cannot make is shown as what WILL be used.
  const shown = working.some((e) => e.id === choice.encoder) ? choice.encoder : FALLBACK_ENCODER
  const info = encoderInfo(shown)
  const canvas = exportCanvas(aspect, choice.resolution)
  const bitrate = choice.bitrateKbps !== null
  const marked = rangeIn !== null || rangeOut !== null

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[11px] text-ink-400">Size</span>
          <span className="font-mono text-[10px] tabular-nums text-ink-600">
            {canvas.width}×{canvas.height}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.id}
              onClick={() => setChoice({ resolution: r.id })}
              title={r.hint}
              className={segment(choice.resolution === r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[11px] text-ink-400">Codec</span>
          {encoders === null && <span className="text-[10px] text-ink-600">checking this machine…</span>}
        </div>
        <select
          value={shown}
          onChange={(e) => setChoice({ encoder: e.target.value as typeof shown })}
          className="w-full rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-200 outline-none"
        >
          {working.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        <div className="mt-1 text-[10.5px] leading-snug text-ink-600">
          {info.hint}
          {info.family === 'prores' &&
            ' — 10-bit 4:2:2, of a picture composed in 8-bit 4:2:0, so it hands on what the edit has without losing more.'}
          {shown !== choice.encoder &&
            ` ${encoderInfo(choice.encoder).label} is not working on this machine.`}
        </div>
      </div>

      {info.family !== 'prores' && (
        <div>
          <div className="mb-1.5 text-[11px] text-ink-400">Quality</div>
          <div className="grid grid-cols-4 gap-1">
            {QUALITY_PRESETS.map((q) => (
              <button
                key={q.id}
                onClick={() => setChoice({ crf: q.crf, bitrateKbps: null })}
                title={`Constant quality, CRF ${q.crf}`}
                className={segment(!bitrate && choice.crf === q.crf)}
              >
                {q.label}
              </button>
            ))}
            <button
              onClick={() =>
                setChoice({ bitrateKbps: bitrateForCrf(choice.crf, canvas.width * canvas.height) })
              }
              title="A fixed bitrate — what a platform means by “upload at 8 Mbps”"
              className={segment(bitrate)}
            >
              Bitrate
            </button>
          </div>
          {bitrate ? (
            <label className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-500">
              <input
                type="number"
                min={BITRATE_RANGE.minKbps / 1000}
                max={BITRATE_RANGE.maxKbps / 1000}
                step={0.5}
                value={(choice.bitrateKbps ?? 0) / 1000}
                onChange={(e) => {
                  const mbps = Number(e.target.value)
                  if (Number.isFinite(mbps) && mbps > 0) setChoice({ bitrateKbps: mbps * 1000 })
                }}
                className="w-20 rounded bg-ink-800 px-2 py-1 font-mono text-[11px] tabular-nums text-ink-200 outline-none"
              />
              Mbps, at most
            </label>
          ) : (
            !info.crf && (
              <div className="mt-1 text-[10.5px] leading-snug text-ink-600">
                A hardware encoder takes a bitrate, so this is about{' '}
                {(bitrateForCrf(choice.crf, canvas.width * canvas.height) / 1000).toFixed(1)} Mbps at this size.
              </div>
            )
          )}
          {!info.hardware && (
            <div className="mt-1.5 grid grid-cols-4 gap-1">
              {SPEEDS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setChoice({ preset: s.id })}
                  title="How hard the encoder works: slower is smaller for the same quality"
                  className={segment(choice.preset === s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-1.5 text-[11px] text-ink-400">Audio</div>
          <select
            value={choice.audioKbps}
            onChange={(e) => setChoice({ audioKbps: Number(e.target.value) })}
            className="w-full rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-200 outline-none"
          >
            {AUDIO_KBPS.map((kbps) => (
              <option key={kbps} value={kbps}>
                AAC {kbps}k
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] text-ink-400">File</div>
          <div className="grid grid-cols-2 gap-1">
            {(['mp4', 'mov'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setChoice({ container: c })}
                // ProRes is a QuickTime codec; an MP4 of it is not a thing.
                disabled={info.requires !== undefined && info.requires !== c}
                className={segment(choice.container === c)}
              >
                .{c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {marked && (
        <label className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-ink-850">
          <input
            type="checkbox"
            checked={useRange}
            onChange={(e) => setUseRange(e.target.checked)}
            className="mt-0.5 shrink-0 accent-flame-500"
          />
          <span className="text-[11px] text-ink-200">
            Only between the marks
            <span className="ml-1 font-mono text-[10px] tabular-nums text-ink-500">
              {formatTimecode(rangeIn ?? 0, fps)} → {rangeOut === null ? 'end' : formatTimecode(rangeOut, fps)}
            </span>
          </span>
        </label>
      )}
    </div>
  )
}
