import { useCallback, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Loader2, X } from 'lucide-react'
import { clipEnd, formatTimecode } from '@shared/timeline'
import { ASPECTS, useEditor, type AspectKey } from '../store'
import { CAPTION_STYLES, resolveStyle, type StyleOverrides } from '@shared/captions/style'
import { FontPicker } from './FontPicker'
import { useCatalog } from '../catalog'
import { TRANSITIONS, availableFamilies, transitionsInFamily } from '@shared/transitions/registry'
import { clipBefore, maxTransitionFrames } from '@shared/timeline'
import { useEffect, useState as useLocalState } from 'react'

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-[11px] text-ink-400">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-ink-200">{value}</span>
    </div>
  )
}

export function Inspector(): ReactNode {
  const project = useEditor((s) => s.project)
  const aspect = useEditor((s) => s.aspect)
  const setAspect = useEditor((s) => s.setAspect)
  const splitRatio = useEditor((s) => s.splitRatio)
  const setSplitRatio = useEditor((s) => s.setSplitRatio)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const jobs = useEditor((s) => s.jobs)
  const notify = useEditor((s) => s.notify)
  const setCaptionStyle = useEditor((s) => s.setCaptionStyle)
  const setCaptionsEnabled = useEditor((s) => s.setCaptionsEnabled)
  const transcriptCount = Object.keys(project.transcripts).length
  const setCaptionOverride = useEditor((s) => s.setCaptionOverride)
  const clearCaptionOverrides = useEditor((s) => s.clearCaptionOverrides)
  const [pickingFont, setPickingFont] = useLocalState(false)
  const setTransition = useEditor((s) => s.setTransition)
  const clearTransition = useEditor((s) => s.clearTransition)

  const loadCatalog = useCatalog((s) => s.load)
  const ensureFont = useCatalog((s) => s.ensureFont)
  const loadedFonts = useCatalog((s) => s.loadedFonts)
  const catalogLoaded = useCatalog((s) => s.catalog !== null)

  const style = resolveStyle(
    project.captions.styleId,
    project.captions.overrides as StyleOverrides | undefined
  )
  const hasOverrides = Object.keys(project.captions.overrides ?? {}).length > 0
  const fontReady = loadedFonts.has(style.fontFamily)

  useEffect(() => {
    if (!catalogLoaded) void loadCatalog()
  }, [catalogLoaded, loadCatalog])

  useEffect(() => {
    void ensureFont(style.fontFamily)
  }, [style.fontFamily, ensureFont, catalogLoaded])
  const [exporting, setExporting] = useState(false)

  const clip = project.clips.find((c) => c.id === selectedClipId) ?? null
  const previousClip = clip ? clipBefore(project, clip) : null
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) ?? null : null
  const fps = project.settings.fps

  const onExport = useCallback(async () => {
    if (project.clips.length === 0) {
      notify('Add something to the timeline first', 'info')
      return
    }
    setExporting(true)
    try {
      const suggested = `${project.name || 'Untitled'}-${aspect.replace(':', 'x')}.mp4`
      const outputPath = await window.forge.chooseExportPath(suggested)
      if (!outputPath) return
      await window.forge.startRender({
        project,
        outputPath,
        canvas: { width: ASPECTS[aspect].width, height: ASPECTS[aspect].height },
        crf: 20,
        preset: 'medium'
      })
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [project, aspect, notify])

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="border-b border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Output
      </div>

      <div className="space-y-3 border-b border-ink-800 p-3">
        <div>
          <div className="mb-1.5 text-[11px] text-ink-400">Aspect ratio</div>
          <div className="grid grid-cols-3 gap-1">
            {(Object.keys(ASPECTS) as AspectKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setAspect(key)}
                title={`${ASPECTS[key].label} — ${ASPECTS[key].width}×${ASPECTS[key].height}`}
                className={`rounded px-2 py-1.5 text-[11px] transition-colors ${
                  aspect === key
                    ? 'bg-flame-500 text-ink-950'
                    : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[10.5px] leading-snug text-ink-600">
            Changing this re-solves every clip&apos;s reframe. Drag the rectangle in the
            preview to correct it.
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] text-ink-400">Preview</div>
          <div className="grid grid-cols-3 gap-1">
            {([
              ['Source', 1],
              ['Split', 0.5],
              ['Output', 0]
            ] as const).map(([label, ratio]) => (
              <button
                key={label}
                onClick={() => setSplitRatio(ratio)}
                className={`rounded px-2 py-1.5 text-[11px] transition-colors ${
                  Math.abs(splitRatio - ratio) < 0.02
                    ? 'bg-ink-700 text-ink-200'
                    : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[10.5px] leading-snug text-ink-600">
            Drag the divider in the preview to compare; double-click it for an even split.
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] text-ink-400">Captions</span>
            <button
              onClick={() => setCaptionsEnabled(!project.captions.enabled)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                project.captions.enabled
                  ? 'bg-flame-500 text-ink-950'
                  : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
              }`}
            >
              {project.captions.enabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="grid gap-1">
            {CAPTION_STYLES.map((style) => (
              <button
                key={style.id}
                onClick={() => setCaptionStyle(style.id)}
                disabled={!project.captions.enabled}
                className={`flex items-center justify-between rounded px-2 py-1.5 text-[11px] transition-colors disabled:opacity-40 ${
                  project.captions.styleId === style.id
                    ? 'bg-ink-700 text-ink-200'
                    : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                }`}
              >
                <span>{style.label}</span>
                <span className="text-[10px] text-ink-600">{style.fontFamily}</span>
              </button>
            ))}
          </div>
          {project.captions.enabled && (
            <div className="mt-1.5">
              <button
                onClick={() => setPickingFont((v) => !v)}
                className="flex w-full items-center justify-between rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
              >
                <span>Font</span>
                <span
                  className="max-w-[60%] truncate text-ink-200"
                  style={fontReady ? { fontFamily: `"${style.fontFamily}", sans-serif` } : undefined}
                >
                  {style.fontFamily}
                </span>
              </button>

              {pickingFont && (
                // A full-height overlay rather than an inline box: 81 families in
                // a 224px scroller reads as "there are only four fonts".
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-10">
                  <div
                    className="flex h-full max-h-[680px] w-full max-w-md flex-col overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FontPicker
                      value={style.fontFamily}
                      onChange={(family) => {
                        setCaptionOverride('fontFamily', family)
                        setPickingFont(false)
                      }}
                      onClose={() => setPickingFont(false)}
                    />
                  </div>
                </div>
              )}

              <div className="mt-1.5 flex items-center gap-2">
                <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Size</span>
                <input
                  type="range"
                  min={24}
                  max={160}
                  step={2}
                  value={style.fontSize}
                  onChange={(e) => setCaptionOverride('fontSize', Number(e.target.value))}
                  className="min-w-0 flex-1"
                />
                <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
                  {style.fontSize}
                </span>
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Words</span>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={style.wordsPerLine}
                  onChange={(e) => setCaptionOverride('wordsPerLine', Number(e.target.value))}
                  className="min-w-0 flex-1"
                />
                <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
                  {style.wordsPerLine}
                </span>
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Highlight</span>
                <input
                  type="color"
                  value={style.highlightColor}
                  onChange={(e) => setCaptionOverride('highlightColor', e.target.value)}
                  className="h-5 w-8 shrink-0 cursor-pointer rounded border border-ink-700 bg-transparent"
                />
                <button
                  onClick={clearCaptionOverrides}
                  disabled={!hasOverrides}
                  className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {transcriptCount === 0 && project.captions.enabled && (
            <div className="mt-1.5 text-[10.5px] leading-snug text-ink-600">
              Nothing transcribed yet — captions will be skipped on export.
            </div>
          )}
        </div>

        <button
          onClick={() => void onExport()}
          disabled={exporting}
          className="flex w-full items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-2 text-[12px] font-medium text-ink-950 transition-colors hover:bg-flame-400 disabled:opacity-50"
        >
          {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          Export
        </button>
      </div>

      <div className="border-b border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Clip
      </div>
      <div className="px-3 py-2">
        {clip && asset ? (
          <>
            <div className="mb-1 truncate text-[12px] text-ink-200">{asset.name}</div>
            <Field label="Start" value={formatTimecode(clip.start, fps)} />
            <Field label="End" value={formatTimecode(clipEnd(clip), fps)} />
            <Field label="Duration" value={formatTimecode(clip.duration, fps)} />
            <Field label="Source in" value={formatTimecode(clip.inPoint, fps)} />
            {clip.crop && (
              <Field label="Reframe" value={`${clip.crop.width}×${clip.crop.height} @ ${clip.crop.x},${clip.crop.y}`} />
            )}
          </>
        ) : (
          <div className="py-2 text-[11px] text-ink-600">No clip selected</div>
        )}
      </div>

      <div className="border-y border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Transition in
      </div>
      {!clip && (
        <div className="px-3 py-2 text-[11px] text-ink-600">Select a clip</div>
      )}
      {clip && !previousClip && (
        <div className="px-3 py-2 text-[10.5px] leading-snug text-ink-600">
          This is the first clip on its track. A transition blends into a clip from the one
          before it, so select a later clip.
        </div>
      )}
      {clip && previousClip && (
        <>
          <div className="space-y-1.5 px-3 py-2">
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => clearTransition(clip.id)}
                className={`rounded px-2 py-1.5 text-[11px] transition-colors ${
                  !clip.transitionIn
                    ? 'bg-ink-700 text-ink-200'
                    : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                }`}
              >
                Cut
              </button>
              {availableFamilies().map((family) => {
                const members = transitionsInFamily(family)
                const active = members.some((m) => m.id === clip.transitionIn?.id)
                return (
                  <button
                    key={family}
                    onClick={() => setTransition(clip.id, members[0].id)}
                    className={`rounded px-2 py-1.5 text-[11px] capitalize transition-colors ${
                      active ? 'bg-flame-500 text-ink-950' : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                    }`}
                  >
                    {family}
                  </button>
                )
              })}
            </div>

            {clip.transitionIn && (
              <>
                <select
                  value={clip.transitionIn.id}
                  onChange={(e) => setTransition(clip.id, e.target.value, clip.transitionIn?.durationFrames)}
                  className="w-full rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-200 outline-none"
                >
                  {TRANSITIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>

                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Length</span>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(2, maxTransitionFrames(previousClip, clip))}
                    step={1}
                    value={clip.transitionIn.durationFrames}
                    onChange={(e) => setTransition(clip.id, clip.transitionIn!.id, Number(e.target.value))}
                    className="min-w-0 flex-1"
                  />
                  <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
                    {(clip.transitionIn.durationFrames / fps).toFixed(2)}s
                  </span>
                </div>
              </>
            )}

            <div className="text-[10.5px] leading-snug text-ink-600">
              A transition consumes time from both clips rather than adding any, so the
              timeline shortens.
            </div>
          </div>
        </>
      )}

      {jobs.length > 0 && (
        <>
          <div className="flex items-center justify-between border-y border-ink-800 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Exports</span>
            <button
              onClick={() => void window.forge.clearFinished()}
              className="text-[10px] text-ink-600 hover:text-ink-200"
            >
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {jobs.map((job) => (
              <div key={job.id} className="border-b border-ink-850 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-ink-200">{job.inputName}</span>
                  {job.status === 'running' && (
                    <button
                      onClick={() => void window.forge.cancelRender(job.id)}
                      title="Cancel"
                      className="shrink-0 rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
                    >
                      <X size={11} />
                    </button>
                  )}
                  {job.status === 'done' && (
                    <button
                      onClick={() => void window.forge.revealPath(job.output)}
                      title="Show in folder"
                      className="shrink-0 rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
                    >
                      <FolderOpen size={11} />
                    </button>
                  )}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-800">
                  <div
                    className={`h-full transition-[width] ${
                      job.status === 'failed'
                        ? 'bg-red-500'
                        : job.status === 'cancelled'
                          ? 'bg-ink-600'
                          : 'bg-flame-500'
                    }`}
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-ink-600">
                  <span className="capitalize">{job.status}</span>
                  <span>{job.speed ?? `${Math.round(job.progress * 100)}%`}</span>
                </div>
                {job.error && (
                  <div className="mt-1 line-clamp-3 text-[10px] leading-snug text-red-400">{job.error}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
