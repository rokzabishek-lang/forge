import { useCallback, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Loader2, X } from 'lucide-react'
import {
  DEFAULT_COLOR,
  clipEnd,
  formatTimecode,
  isNeutralGrade,
  type TextSpec
} from '@shared/timeline'
import { ASPECTS, useEditor, type AspectKey } from '../store'
import { CAPTION_STYLES, resolveStyle, type StyleOverrides } from '@shared/captions/style'
import { REFERENCE_HEIGHT } from '@shared/captions/ass'
import { captionSpec } from '@shared/captions/line'
import { captionNeedsCanvas } from '@shared/graphics/fromTimeline'
import { bakeCaptions } from '../captionBake'
import { Sparkles } from 'lucide-react'
import { FontPicker } from './FontPicker'
import { Keyframes } from './Keyframes'
import { useCatalog } from '../catalog'
import { transitionsByFamily } from '../catalog'
import { availableTags, transitionsWithTag } from '@shared/transitions/registry'
import { TAG_LABELS, type MaskTag } from '@shared/transitions/classify'
import { PATH_PRESETS } from '@shared/render/path'
import { TEXT_PRESETS, matchingPreset } from '@shared/render/textPresets'
import { SANDWICH_RULE } from '@shared/automation/sandwich'
import { maxTransitionFrames, transitionBase } from '@shared/timeline'
import { LOUDNESS_TARGETS } from '@shared/render/loudness'
import { LayoutPanel } from './LayoutPanel'
import { MaskPanel } from './MaskPanel'
import { SpeedPanel } from './SpeedPanel'
import { TextStylePicker } from './TextStylePicker'
import { TextAnimationPicker } from './TextAnimationPicker'
import { Slider } from './Slider'
import { useEffect, useMemo, useMemo as useMemoLocal, useState as useLocalState } from 'react'

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
  const setTransform = useEditor((s) => s.setTransform)
  const setColor = useEditor((s) => s.setColor)
  const setClipVolume = useEditor((s) => s.setClipVolume)
  const crossfadeWithPrevious = useEditor((s) => s.crossfadeWithPrevious)
  const setLoudness = useEditor((s) => s.setLoudness)
  const chooseLut = useEditor((s) => s.chooseLut)
  const setPath = useEditor((s) => s.setPath)
  const addWaypoint = useEditor((s) => s.addWaypoint)
  const putBehindSubject = useEditor((s) => s.putBehindSubject)
  const fillWithClipBelow = useEditor((s) => s.fillWithClipBelow)
  const releaseMatte = useEditor((s) => s.releaseMatte)
  const removeSandwich = useEditor((s) => s.removeSandwich)
  const setText = useEditor((s) => s.setText)
  const setSolid = useEditor((s) => s.setSolid)
  const setClipDuration = useEditor((s) => s.setClipDuration)
  const setCaptionStyle = useEditor((s) => s.setCaptionStyle)
  const setCaptionsEnabled = useEditor((s) => s.setCaptionsEnabled)
  const transcriptCount = Object.keys(project.transcripts).length
  const setCaptionOverride = useEditor((s) => s.setCaptionOverride)
  const clearCaptionOverrides = useEditor((s) => s.clearCaptionOverrides)
  const [pickingFont, setPickingFont] = useLocalState(false)
  const [pickingTextFont, setPickingTextFont] = useLocalState(false)
  /** The looks that ship with the app, written to disk on first use. */
  const [looks, setLooks] = useLocalState<
    { id: string; name: string; description: string; file: string }[]
  >([])

  useEffect(() => {
    void window.forge.builtInLooks().then(setLooks).catch(() => setLooks([]))
  }, [])
  /*
   * The "check graphics engine" button used to live here.
   *
   * It probed whether the offscreen browser's `capturePage()` returned real
   * alpha, because styled captions depended on that. They no longer go near it —
   * they are painted on a canvas in this window — so the button was testing a
   * subsystem the feature beside it had stopped using. `graphicsSelfTest` is
   * still there on the API for whenever something needs the frame server again.
   */
  const setTransition = useEditor((s) => s.setTransition)
  const clearTransition = useEditor((s) => s.clearTransition)
  const setTitleText = useEditor((s) => s.setTitleText)
  const allTransitions = useCatalog((s) => s.transitions)
  const transitionsError = useCatalog((s) => s.transitionsError)
  const loadTransitions = useCatalog((s) => s.loadTransitions)
  const families = useMemoLocal(() => transitionsByFamily(allTransitions), [allTransitions])
  const tags = useMemoLocal(() => availableTags(allTransitions), [allTransitions])
  const [tagFilter, setTagFilter] = useLocalState<MaskTag | null>(null)

  useEffect(() => {
    void loadTransitions()
  }, [loadTransitions])

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

  /*
   * A caption the style pickers can draw.
   *
   * Both pickers preview a TextSpec, so a caption becomes one — built by the
   * same function the export uses, with a word lit, so what a tile shows is
   * genuinely this style with this highlight rather than an impression of it.
   * Centred and enlarged only because a tile is not a frame: at a caption's real
   * size and position it would be four pixels tall in the corner of the tile.
   *
   * Two short words, and no more. A tile is 38 pixels tall and the picker draws
   * into it at nearly half that in type, so a line long enough to wrap fills the
   * tile edge to edge — measured: "YOUR WORDS HERE" came out clipped top and
   * bottom, and "YOUR WORDS" still touched both. Two words is the minimum that
   * shows a highlight against a base, and short ones stay on one row.
   */
  const captionSample = useMemo<TextSpec>(() => {
    const words = 'GO BIG'.split(' ').map((text, index) => ({
      index,
      text,
      startMs: index * 300,
      endMs: index * 300 + 300,
      confidence: 1
    }))
    return {
      ...captionSpec(style, words, 1),
      position: 'center',
      offsetY: 0,
      size: 0.2
    }
  }, [style])

  useEffect(() => {
    if (!catalogLoaded) void loadCatalog()
  }, [catalogLoaded, loadCatalog])

  useEffect(() => {
    void ensureFont(style.fontFamily)
  }, [style.fontFamily, ensureFont, catalogLoaded])
  const [exporting, setExporting] = useState(false)
  const [draft, setDraft] = useState(false)

  const clip = project.clips.find((c) => c.id === selectedClipId) ?? null
  /*
   * What a transition would blend in from: the clip before it on the same track,
   * or the layer underneath it. The panel used to require the former, so a
   * photograph dropped on V2 over another one — the whole grid-reveal edit —
   * had no transition UI at all.
   */
  const base = clip ? transitionBase(project, clip) : null
  const previousClip = base?.kind === 'cut' ? base.clip : null
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) ?? null : null
  const fps = project.settings.fps

  const onExport = useCallback(async () => {
    if (project.clips.length === 0) {
      notify('Add something to the timeline first', 'info')
      return
    }
    setExporting(true)
    try {
      const suggested =
        `${project.name || 'Untitled'}-${aspect.replace(':', 'x')}${draft ? '-draft' : ''}.mp4`
      const outputPath = await window.forge.chooseExportPath(suggested)
      if (!outputPath) return

      /*
       * Draft halves the canvas, which is a quarter of the pixels.
       *
       * The render cost is pixel-bound in the filter graph, not in the encoder:
       * measured on 8 clips over 12s, 29.5s at 1080x1920 against 8.0s at
       * 540x960. Nothing else moved the needle — the encoder preset made no
       * difference, filter threading made no difference, and replacing the
       * overlay chain with concat was ten times SLOWER.
       */
      const full = ASPECTS[aspect]
      const canvas = draft
        ? { width: Math.round(full.width / 2 / 2) * 2, height: Math.round(full.height / 2 / 2) * 2 }
        : { width: full.width, height: full.height }

      /*
       * Draw the generated cards to disk, here, once.
       *
       * Text, colour cards and titles are drawn live in the preview from their
       * spec, so editing them never touches a file — which is what made typing
       * instant. The PNGs still have to exist for ffmpeg, and this is the one
       * moment they genuinely matter. Baking on the way out means the files
       * always match the words on screen, without a disk write behind every
       * keystroke.
       */
      await useEditor.getState().rebakeGenerated()

      /*
       * Styled captions, drawn here rather than by a second render pass.
       *
       * Only the looks libass cannot burn in come through here, and only the
       * pictures that actually differ get drawn — a still caption is one file
       * held for as long as it is on screen. Everything else about the export is
       * unchanged, which is the point: one pass, one encode.
       */
      const captionOverlay = captionNeedsCanvas(style)
        ? (await bakeCaptions(useEditor.getState().project, canvas).catch((err) => {
            // A bake that fails must not lose the export. Falling back means
            // captions come out flat rather than styled, which is visible and
            // recoverable; a failed export is neither.
            notify(
              `Captions could not be drawn, so they will be burned in plain: ${
                err instanceof Error ? err.message : String(err)
              }`,
              'info'
            )
            return null
          })) ?? undefined
        : undefined

      await window.forge.startRender({
        // The rebake repointed assets at freshly written files, so the project
        // captured before it is already out of date.
        project: useEditor.getState().project,
        outputPath,
        canvas,
        crf: draft ? 26 : 20,
        preset: 'medium',
        captionOverlay: captionOverlay
          ? {
              listPath: captionOverlay.listPath,
              y: captionOverlay.y,
              height: captionOverlay.height
            }
          : undefined
      })
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [project, aspect, notify])

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="shrink-0 border-b border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Output
      </div>

      {/*
        The panel body scrolls; the Exports block below does not.

        Without this the column simply overflowed its height and everything past
        the fold — the export progress included — was off-screen and could not be
        reached, so a render that was running looked like a render that had never
        started.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto">
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

        {/*
          Loudness sits with the other things that describe the FILE, not with
          the clip's own Sound row. It is a property of the export: every clip,
          every track and the music all measured together after the mix.
        */}
        <div>
          <div className="mb-1.5 text-[11px] text-ink-400">Loudness</div>
          {/*
            Two columns, not four. The panel is narrow enough at its default
            width that four turned "Broadcast" into "Broad" — and a row of
            clipped words is worse than a row half as wide, because the one
            thing a preset button has to do is say what it is.
          */}
          <div className="grid grid-cols-2 gap-1">
            {([['Off', undefined] as const] as readonly (readonly [string, number | undefined])[])
              .concat(LOUDNESS_TARGETS.map((t) => [t.label, t.lufs] as const))
              .map(([label, lufs]) => {
                const active = (project.settings.loudness ?? undefined) === lufs
                return (
                  <button
                    key={label}
                    onClick={() => setLoudness(lufs)}
                    title={
                      lufs === undefined
                        ? 'Export at whatever level the sources happen to be'
                        : `${lufs} LUFS — ${LOUDNESS_TARGETS.find((t) => t.lufs === lufs)?.hint}`
                    }
                    className={`flex items-baseline justify-center gap-1 rounded px-2 py-1.5 text-[11px] transition-colors ${
                      active
                        ? 'bg-flame-500 text-ink-950'
                        : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
                    }`}
                  >
                    {label}
                    {lufs !== undefined && (
                      <span className={`text-[9px] tabular-nums ${active ? 'text-ink-950/70' : 'text-ink-600'}`}>
                        {lufs}
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
          <div className="mt-1.5 text-[10.5px] leading-snug text-ink-600">
            {project.settings.loudness === undefined
              ? 'Two exports can land at noticeably different levels.'
              : `Every export measured to ${project.settings.loudness} LUFS, so one is as loud as the next.`}
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
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] text-ink-400">Captions</span>
            <div className="flex items-center gap-1">
              {/*
                Reset lived inside the Highlight colour row, pushed right with
                ml-auto — so a button that wipes the font, the size, the words
                per line, the style and the animation read as if it belonged to
                the colour beside it.
              */}
              <button
                onClick={clearCaptionOverrides}
                disabled={!hasOverrides}
                className="rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
              >
                Reset edits
              </button>
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
          </div>

          {/*
            What this is, in one line.

            Captions and text cards share a painter, a style library and an
            animation library, so on screen they can look identical — and the
            panels gave no clue which to reach for. The difference is where the
            words come from and how many there are: captions are spoken words,
            timed automatically, for the whole project; a text card is one line
            you type and place yourself.
          */}
          <p className="mb-1.5 text-[10px] leading-snug text-ink-600">
            Spoken words from the transcript, timed automatically across the whole project.
            To type one line yourself, use <span className="text-ink-400">+ Text</span>.
          </p>
          <div className="grid gap-1">
            {CAPTION_STYLES.map((preset) => (
              <button
                key={preset.id}
                onClick={() => setCaptionStyle(preset.id)}
                disabled={!project.captions.enabled}
                className={`flex items-center justify-between rounded px-2 py-1.5 text-[11px] transition-colors disabled:opacity-40 ${
                  project.captions.styleId === preset.id
                    ? 'bg-ink-700 text-ink-200'
                    : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                }`}
              >
                <span className="flex items-center gap-1">
                  {preset.label}
                  {preset.animated && (
                    <Sparkles
                      size={9}
                      className="text-flame-400"
                    />
                  )}
                </span>
                <span className="text-[10px] text-ink-600">{preset.fontFamily}</span>
              </button>
            ))}
          </div>
          {project.captions.enabled && (
            <div className="mt-1.5">
              {/*
                The same two libraries the text clips use.

                Captions were the one place that could not reach them, which is
                backwards: a caption is the most-seen type in a short video, and
                the looks the reference packs are built from are all here. A
                style or an animation moves the captions onto the drawn path —
                libass can burn in a flat caption for free, but it has no
                gradient, no glow and no per-word easing to give.
              */}
              <TextStylePicker
                spec={captionSample}
                onPick={(id) => setCaptionOverride('textStyleId', id)}
              />
              <div className="mt-1.5">
                <TextAnimationPicker
                  spec={captionSample}
                  onPick={(id) => setCaptionOverride('animationId', id)}
                />
              </div>

              <button
                onClick={() => setPickingFont((v) => !v)}
                className="mt-1.5 flex w-full items-center justify-between rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
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

              {/*
                The same control, in the same units, as the text card's.

                This was a hand-rolled range in POINTS against a 1080-tall
                reference while the text card's Size was the shared Slider in
                PER CENT — two sliders with the same label, different widgets
                and different numbers for the same idea. Captions are authored
                against the reference frame, so the conversion happens here and
                the panel reads the way its neighbour does.
              */}
              <div className="mt-1.5 space-y-1.5">
                <Slider
                  label="Size"
                  value={Math.round((style.fontSize / REFERENCE_HEIGHT) * 100)}
                  min={2}
                  max={30}
                  suffix="%"
                  onChange={(v) =>
                    setCaptionOverride('fontSize', Math.round((v / 100) * REFERENCE_HEIGHT))
                  }
                />
                <Slider
                  label="Words"
                  value={style.wordsPerLine}
                  min={1}
                  max={8}
                  suffix=""
                  onChange={(v) => setCaptionOverride('wordsPerLine', v)}
                />

                {/*
                  Position, which captions always supported and never exposed.

                  `CaptionStyle.position` and `marginV` were both honoured all
                  the way through resolve, layout and render — there was simply
                  no control, so the only way to move a caption was to give up
                  and use a text card instead. That is a large part of why text
                  cards looked like the better captions.
                */}
                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Place</span>
                  <div className="grid flex-1 grid-cols-3 gap-1">
                    {(['top', 'center', 'bottom'] as const).map((place) => (
                      <button
                        key={place}
                        onClick={() => setCaptionOverride('position', place)}
                        className={`rounded px-1.5 py-1 text-[10px] capitalize transition-colors ${
                          style.position === place
                            ? 'bg-flame-500 text-ink-950'
                            : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                        }`}
                      >
                        {place === 'center' ? 'Middle' : place}
                      </button>
                    ))}
                  </div>
                </div>

                {style.position !== 'center' && (
                  <Slider
                    label="Margin"
                    value={Math.round((style.marginV / REFERENCE_HEIGHT) * 100)}
                    min={0}
                    max={40}
                    suffix="%"
                    onChange={(v) =>
                      setCaptionOverride('marginV', Math.round((v / 100) * REFERENCE_HEIGHT))
                    }
                  />
                )}

                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Colour</span>
                  <input
                    type="color"
                    value={style.primaryColor}
                    onChange={(e) => setCaptionOverride('primaryColor', e.target.value)}
                    title="The words"
                    className="h-5 w-8 shrink-0 cursor-pointer rounded border border-ink-700 bg-transparent"
                  />
                  <input
                    type="color"
                    value={style.highlightColor}
                    onChange={(e) => setCaptionOverride('highlightColor', e.target.value)}
                    title="The word being spoken"
                    className="h-5 w-8 shrink-0 cursor-pointer rounded border border-ink-700 bg-transparent"
                  />
                  <span className="text-[10px] text-ink-600">words · spoken</span>
                </div>
              </div>
            </div>
          )}

          {captionNeedsCanvas(style) && project.captions.enabled && (
            <div className="mt-1.5 rounded border border-flame-500/40 bg-flame-500/10 px-2 py-1.5">
              <div className="text-[10.5px] leading-snug text-flame-300">
                {/*
                  Which path these captions take, said plainly and accurately.

                  This used to warn that the export ran a second pass, which it
                  did — and which cost about five times the render. It does not
                  any more: the captions are drawn to a few pictures first and
                  composited by the ordinary graph.
                */}
                These captions are drawn rather than burned in. They are painted once
                before the export and composited in the same pass, so it costs a little
                more than a plain style — not a second render.
              </div>
            </div>
          )}

          {transcriptCount === 0 && project.captions.enabled && (
            <div className="mt-1.5 text-[10.5px] leading-snug text-ink-600">
              Nothing transcribed yet — captions will be skipped on export.
            </div>
          )}
        </div>

        <label className="mb-1.5 flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-ink-850">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            className="mt-0.5 shrink-0 accent-flame-500"
          />
          <span className="min-w-0">
            <span className="block text-[11px] text-ink-200">
              Draft — half size, about 4x faster
            </span>
            <span className="mt-0.5 block text-[10px] leading-snug text-ink-600">
              {draft
                ? `${Math.round(ASPECTS[aspect].width / 2 / 2) * 2}x${Math.round(ASPECTS[aspect].height / 2 / 2) * 2} — for checking the edit, not for posting.`
                : `${ASPECTS[aspect].width}x${ASPECTS[aspect].height}. Render cost is pixel-bound, so half size is a quarter of the work.`}
            </span>
          </span>
        </label>

        <button
          onClick={() => void onExport()}
          disabled={exporting}
          className="flex w-full items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-2 text-[12px] font-medium text-ink-950 transition-colors hover:bg-flame-400 disabled:opacity-50"
        >
          {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {draft ? 'Export draft' : 'Export'}
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
            {/* Editable, not just reported: how long a title holds is the most
                common thing to change about one. */}
            <div className="flex items-center gap-2 py-1">
              <span className="w-14 shrink-0 text-[11px] text-ink-400">Duration</span>
              <input
                type="range"
                min={Math.max(1, Math.round(fps * 0.2))}
                max={Math.round(fps * 15)}
                step={1}
                value={clip.duration}
                onChange={(e) => setClipDuration(clip.id, Number(e.target.value))}
                className="min-w-0 flex-1"
              />
              <span className="w-14 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-ink-200">
                {(clip.duration / fps).toFixed(1)}s
              </span>
            </div>
            <Field label="Source in" value={formatTimecode(clip.inPoint, fps)} />
            {clip.crop && (
              <Field label="Reframe" value={`${clip.crop.width}×${clip.crop.height} @ ${clip.crop.x},${clip.crop.y}`} />
            )}

            {/*
              Size, position and opacity.

              These were on every clip from the start and drawn by nothing, so a
              prop landed at full frame with no way to shrink it. 100% means the
              clip fills the frame, which is what every existing clip already does.
            */}
            <div className="mt-2 space-y-1.5 border-t border-ink-850 pt-2">
              <Slider
                label="Size"
                value={Math.round((clip.transform?.scale ?? 1) * 100)}
                min={5}
                max={200}
                suffix="%"
                onChange={(v) => setTransform(clip.id, { scale: v / 100 })}
              />
              <Slider
                label="Opacity"
                value={Math.round((clip.transform?.opacity ?? 1) * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => setTransform(clip.id, { opacity: v / 100 })}
              />
              <Slider
                label="X"
                value={Math.round((clip.transform?.x ?? 0) * 100)}
                min={-100}
                max={100}
                suffix=""
                onChange={(v) => setTransform(clip.id, { x: v / 100 })}
              />
              <Slider
                label="Y"
                value={Math.round((clip.transform?.y ?? 0) * 100)}
                min={-100}
                max={100}
                suffix=""
                onChange={(v) => setTransform(clip.id, { y: v / 100 })}
              />
              <Slider
                label="Rotate"
                value={Math.round(clip.transform?.rotation ?? 0)}
                min={-180}
                max={180}
                suffix="°"
                onChange={(v) => setTransform(clip.id, { rotation: v })}
              />

              {/*
                Colour.

                The three sliders are ffmpeg's `eq` parameters directly, so what
                is on screen and what is exported run the same numbers. The LUT
                goes on top of them, which is the order Resolve and CapCut both
                use: correct the picture, then put the look on it.
              */}
              {/* Speed belongs next to duration: it is the other way to change one. */}
              <SpeedPanel clip={clip} asset={asset} />

              {/*
                Sound, for anything that has some.

                The render has always honoured `clip.volume` and nothing could
                set it, so every clip played its source at full volume with no
                way to say otherwise. Clip stickers made that unbearable: they
                carry loud speech and land muted, and without this there would
                be no way to hear them at all.
              */}
              {asset?.hasAudio && (
                <div className="space-y-1.5 border-t border-ink-850 pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10.5px] text-ink-400">Sound</span>
                    <button
                      onClick={() => setClipVolume(clip.id, (clip.volume ?? 1) > 0 ? 0 : 1)}
                      title={(clip.volume ?? 1) > 0 ? 'Mute this clip' : 'Unmute this clip'}
                      className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                        (clip.volume ?? 1) > 0
                          ? 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
                          : 'bg-flame-500 font-medium text-ink-950 hover:bg-flame-400'
                      }`}
                    >
                      {(clip.volume ?? 1) > 0 ? 'Mute' : 'Muted'}
                    </button>
                  </div>
                  <Slider
                    label="Level"
                    value={Math.round((clip.volume ?? 1) * 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(v) => setClipVolume(clip.id, v / 100)}
                  />

                  {/*
                    Crossfade needs a button because it cannot be a drag.

                    Every other fade control is on the clip, which is where
                    they belong — but this one has to CREATE the overlap it
                    fades across, and the drag that would do it is already
                    taken: dragging a clip onto its neighbour sequences it
                    clear, and that behaviour is load-bearing for stacked
                    layers like grids and filmstrips. So the button makes the
                    overlap, and the grips on the clip shape it afterwards.
                  */}
                  <button
                    onClick={() => crossfadeWithPrevious(clip.id)}
                    title="Overlap this clip with the one before it on its track and cross the sound over"
                    className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-300 transition-colors hover:bg-ink-700 hover:text-ink-100"
                  >
                    Crossfade with the clip before
                  </button>
                </div>
              )}

              {/*
               * The mask sits above the colour controls on purpose: in grade
               * mode those sliders apply only inside the shape, and reading
               * "colour only inside" after moving them is the wrong order.
               */}
              <MaskPanel clip={clip} />

              <div className="space-y-1.5 border-t border-ink-850 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] text-ink-400">
                    Colour
                    {clip.mask?.mode === 'grade' && (
                      <span className="ml-1 text-flame-400">· inside the mask only</span>
                    )}
                  </span>
                  {!isNeutralGrade(clip.color) && (
                    <button
                      onClick={() =>
                        setColor(clip.id, { ...DEFAULT_COLOR, lut: undefined })
                      }
                      className="rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200"
                    >
                      Reset
                    </button>
                  )}
                </div>
                <Slider
                  label="Bright"
                  value={Math.round((clip.color?.brightness ?? 0) * 100)}
                  min={-100}
                  max={100}
                  suffix=""
                  onChange={(v) => setColor(clip.id, { brightness: v / 100 })}
                />
                <Slider
                  label="Contrast"
                  value={Math.round((clip.color?.contrast ?? 1) * 100)}
                  min={0}
                  max={300}
                  suffix="%"
                  onChange={(v) => setColor(clip.id, { contrast: v / 100 })}
                />
                <Slider
                  label="Saturate"
                  value={Math.round((clip.color?.saturation ?? 1) * 100)}
                  min={0}
                  max={300}
                  suffix="%"
                  onChange={(v) => setColor(clip.id, { saturation: v / 100 })}
                />

                {clip.color?.lut ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[10.5px] text-flame-400" title={clip.color.lut.file}>
                        {clip.color.lut.name ?? 'LUT'}
                      </span>
                      <button
                        onClick={() => setColor(clip.id, { lut: undefined })}
                        title="Remove this look"
                        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200"
                      >
                        Remove
                      </button>
                    </div>
                    <Slider
                      label="Intensity"
                      value={Math.round(clip.color.lut.intensity * 100)}
                      min={0}
                      max={100}
                      suffix="%"
                      onChange={(v) =>
                        setColor(clip.id, { lut: { ...clip.color!.lut!, intensity: v / 100 } })
                      }
                    />
                  </>
                ) : (
                  <div className="space-y-1">
                    <div className="text-[10px] text-ink-500">Looks</div>
                    <div className="grid grid-cols-2 gap-1">
                      {looks.map((look) => (
                        <button
                          key={look.id}
                          onClick={() =>
                            setColor(clip.id, {
                              lut: { file: look.file, name: look.name, intensity: 0.8 }
                            })
                          }
                          title={look.description}
                          className="truncate rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
                        >
                          {look.name}
                        </button>
                      ))}
                    </div>
                    {/*
                      Still offered, because a photographer who already owns
                      LUTs should not have to use ours — but no longer the only
                      way in, which made the panel unusable to everyone else.
                    */}
                    <button
                      onClick={() => void chooseLut(clip.id)}
                      title="Load a .cube LUT you already own, as exported by any grading tool"
                      className="w-full rounded px-2 py-1 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-300"
                    >
                      or load your own .cube…
                    </button>
                  </div>
                )}
              </div>
              {clip.text && (
                <div className="space-y-1.5 border-t border-ink-850 pt-2">
                  {/* The other half of the pair — see the note in the Captions
                      block. These two share a painter and a style library, so
                      the only thing that distinguishes them is said out loud. */}
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] text-ink-400">Text card</span>
                    <span className="text-[10px] text-ink-600">one line, placed by you</span>
                  </div>
                  <textarea
                    value={clip.text.content}
                    onChange={(e) => void setText(clip.id, { content: e.target.value })}
                    rows={2}
                    placeholder="Type your text"
                    className="w-full resize-none rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-200 outline-none placeholder:text-ink-600"
                  />

                  {/*
                    Looks, before sliders.

                    Ten sliders with no starting point is the slowest way to a
                    decent title: each one is a decision and most only read well
                    in combination. A preset is that combination, already made.
                  */}
                  <div className="grid grid-cols-3 gap-1">
                    {TEXT_PRESETS.map((preset) => {
                      const on = matchingPreset(clip.text!)?.id === preset.id
                      return (
                        <button
                          key={preset.id}
                          onClick={() => void setText(clip.id, preset.spec)}
                          title={preset.description}
                          className={`truncate rounded px-1.5 py-1 text-[10px] transition-colors ${
                            on
                              ? 'bg-flame-500 text-ink-950'
                              : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                          }`}
                        >
                          {preset.name}
                        </button>
                      )
                    })}
                  </div>

                  {/*
                    The style library, under the layout presets.

                    The presets above set the TYPOGRAPHY — size, weight,
                    tracking, where it sits. These set the LOOK — the fill, the
                    glow, the outline. Two axes, deliberately: any style works
                    with any preset and with any font, which is what keeps two
                    dozen recipes from having to become hundreds of variants.
                  */}
                  <TextStylePicker
                    spec={clip.text}
                    onPick={(styleId) => void setText(clip.id, { styleId })}
                  />

                  {/*
                    How the words arrive — the third axis.

                    Preset, style and animation are independent on purpose: the
                    preset says how the type is set, the style how it is painted,
                    and this how it moves. Any combination works, so nine
                    animations multiply the library rather than adding to it.
                  */}
                  <TextAnimationPicker
                    spec={clip.text}
                    onPick={(animationId) => void setText(clip.id, { animationId })}
                  />

                  {/*
                    The catalogue's fonts, on text cards.

                    They were only ever wired to captions, so a text card was
                    stuck on whatever the rasteriser happened to use.
                  */}
                  <button
                    onClick={() => setPickingTextFont(true)}
                    className="flex w-full items-center justify-between rounded bg-ink-800 px-2 py-1 text-[10.5px] text-ink-200 hover:bg-ink-700"
                  >
                    <span className="truncate" style={{ fontFamily: clip.text.font }}>
                      {clip.text.font}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-500">Change</span>
                  </button>

                  {pickingTextFont && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-10">
                      <div
                        className="flex h-full max-h-[680px] w-full max-w-md flex-col overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FontPicker
                          value={clip.text.font}
                          onChange={(family) => {
                            void setText(clip.id, { font: family })
                            setPickingTextFont(false)
                          }}
                          onClose={() => setPickingTextFont(false)}
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex gap-1">
                    {(['top', 'center', 'lower'] as const).map((where) => (
                      <button
                        key={where}
                        onClick={() => void setText(clip.id, { position: where })}
                        title={where === 'lower' ? 'Lower third' : where}
                        className={`flex-1 rounded px-1.5 py-0.5 text-[10px] capitalize ${
                          clip.text!.position === where
                            ? 'bg-ink-700 text-ink-200'
                            : 'bg-ink-800 text-ink-500 hover:bg-ink-700'
                        }`}
                      >
                        {where === 'lower' ? 'Lower 3rd' : where}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    {(['left', 'center', 'right'] as const).map((where) => (
                      <button
                        key={where}
                        onClick={() => void setText(clip.id, { align: where })}
                        className={`flex-1 rounded px-1.5 py-0.5 text-[10px] capitalize ${
                          clip.text!.align === where
                            ? 'bg-ink-700 text-ink-200'
                            : 'bg-ink-800 text-ink-500 hover:bg-ink-700'
                        }`}
                      >
                        {where}
                      </button>
                    ))}
                  </div>
                  <Slider
                    label="Size"
                    value={Math.round(clip.text.size * 100)}
                    min={2}
                    max={30}
                    suffix="%"
                    onChange={(v) => void setText(clip.id, { size: v / 100 })}
                  />
                  {/* Tracking is the single biggest lever on whether type reads
                      as a film title or a caption. */}
                  <Slider
                    label="Tracking"
                    value={Math.round(clip.text.tracking * 100)}
                    min={-10}
                    max={50}
                    suffix=""
                    onChange={(v) => void setText(clip.id, { tracking: v / 100 })}
                  />
                  <Slider
                    label="Weight"
                    value={clip.text.weight}
                    min={100}
                    max={900}
                    suffix=""
                    onChange={(v) => void setText(clip.id, { weight: Math.round(v / 100) * 100 })}
                  />
                  <Slider
                    label="Shadow"
                    value={Math.round(clip.text.shadow * 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(v) => void setText(clip.id, { shadow: v / 100 })}
                  />
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Colour</span>
                    <input
                      type="color"
                      value={clip.text.color}
                      onChange={(e) => void setText(clip.id, { color: e.target.value })}
                      className="h-6 w-10 cursor-pointer rounded border border-ink-700 bg-ink-800"
                    />
                    <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-ink-400">
                      <input
                        type="checkbox"
                        checked={clip.text.uppercase}
                        onChange={(e) => void setText(clip.id, { uppercase: e.target.checked })}
                        className="accent-flame-500"
                      />
                      CAPS
                    </label>
                  </div>

                  {/*
                    Outline.

                    `stroke` and `strokeColor` have been in the spec and drawn by
                    both the SVG and the canvas from the start, and reachable
                    from nowhere — which is most of what "the text options are
                    very limited" meant. An outline is what makes type survive a
                    busy frame.
                  */}
                  <Slider
                    label="Outline"
                    value={Math.round((clip.text.stroke ?? 0) * 100)}
                    min={0}
                    max={20}
                    suffix="%"
                    onChange={(v) => void setText(clip.id, { stroke: v / 100 })}
                  />
                  {(clip.text.stroke ?? 0) > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Edge</span>
                      <input
                        type="color"
                        value={clip.text.strokeColor}
                        onChange={(e) => void setText(clip.id, { strokeColor: e.target.value })}
                        className="h-6 w-10 cursor-pointer rounded border border-ink-700 bg-ink-800"
                      />
                      <span className="font-mono text-[10px] text-ink-600">
                        {clip.text.strokeColor}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {clip.solid && (
                <div className="space-y-1.5 border-t border-ink-850 pt-2">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10.5px] text-ink-400">Colour</span>
                    <input
                      type="color"
                      value={clip.solid.color}
                      onChange={(e) => void setSolid(clip.id, { color: e.target.value })}
                      className="h-6 w-10 cursor-pointer rounded border border-ink-700 bg-ink-800"
                    />
                    <span className="font-mono text-[10px] text-ink-600">{clip.solid.color}</span>
                  </div>
                  <Slider
                    label="Opacity"
                    value={Math.round(clip.solid.opacity * 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(v) => void setSolid(clip.id, { opacity: v / 100 })}
                  />
                </div>
              )}

              {/*
                Text behind the subject.

                Offered on any clip, because the useful case is a title but a
                sticker or prop behind someone is the same operation.
              */}
              {/*
                Text as a window onto the picture below — the trailer look.

                Offered on any clip, because a sticker or a shape cut out of
                footage is the same operation as a word cut out of it.
              */}
              {clip.matteOnly ? (
                <button
                  onClick={() => releaseMatte(clip.id)}
                  className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                >
                  The picture below shows through this — put it back
                </button>
              ) : (
                <button
                  onClick={() => fillWithClipBelow(clip.id)}
                  title="The clip on the track below is shown only inside this shape"
                  className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
                >
                  Fill with the picture below
                </button>
              )}

              {clip.generatedBy?.rule === SANDWICH_RULE ? (
                <button
                  onClick={() => removeSandwich(clip.id)}
                  className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                >
                  This is a subject cutout — put the photo back together
                </button>
              ) : (
                <button
                  onClick={() => putBehindSubject(clip.id)}
                  title="Splits the photo beneath into background and subject, with this clip between"
                  className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
                >
                  Put behind the subject
                </button>
              )}

              {/*
                Split screen and picture in picture.

                Both are layouts, not modes: each one writes a box into the
                clip's transform and nothing else. That is why they sit beside
                the matte and the sandwich rather than in a panel of their own —
                same family, same escape hatch, which is to drag the clip back.
              */}
              <LayoutPanel clip={clip} />

              <Keyframes clip={clip} />

              {/*
                Motion path.

                Position only: `scale` with eval=frame re-evaluates but does not
                follow its own expression, so animated size is not offered
                rather than offered and wrong.
              */}
              <div className="pt-1">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10.5px] text-ink-400">Motion path</span>
                  {clip.path && clip.path.length > 0 && (
                    <span className="font-mono text-[10px] text-flame-400">
                      {clip.path.length} point{clip.path.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {PATH_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => setPath(clip.id, preset.build(clip.duration))}
                      className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="mt-1 flex gap-1">
                  <button
                    onClick={() => addWaypoint(clip.id)}
                    title="Record where this clip sits right now, at the playhead"
                    className="flex-1 rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                  >
                    Add point at playhead
                  </button>
                  {clip.path && (
                    <button
                      onClick={() => setPath(clip.id, undefined)}
                      className="rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {clip.path && clip.path.length === 1 && (
                  <div className="mt-1 text-[10px] leading-snug text-amber-500">
                    One point is a fixed offset, not a move — add a second.
                  </div>
                )}
              </div>

              {(clip.transform?.scale !== 1 ||
                clip.transform?.opacity !== 1 ||
                clip.transform?.x !== 0 ||
                clip.transform?.y !== 0 ||
                clip.transform?.rotation !== 0) && (
                <button
                  onClick={() =>
                    setTransform(clip.id, { scale: 1, opacity: 1, x: 0, y: 0, rotation: 0 })
                  }
                  className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                >
                  Reset to full frame
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="py-2 text-[11px] text-ink-600">No clip selected</div>
        )}
      </div>

      {clip?.title && (
        <>
          <div className="border-y border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
            Title text
          </div>
          <div className="space-y-1.5 px-3 py-2">
            {clip.title.texts.map((text, index) => (
              <input
                key={index}
                value={text}
                onChange={(e) => void setTitleText(clip.id, index, e.target.value)}
                placeholder={`Line ${index + 1}`}
                className="w-full rounded bg-ink-800 px-2 py-1.5 text-[11.5px] text-ink-200 outline-none placeholder:text-ink-600 focus:bg-ink-700"
              />
            ))}
            <div className="text-[10.5px] leading-snug text-ink-600">
              The template keeps its own typography — editing the copy re-renders it.
            </div>
          </div>
        </>
      )}

      <div className="border-y border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Transition in
      </div>
      {!clip && (
        <div className="px-3 py-2 text-[11px] text-ink-600">Select a clip</div>
      )}
      {clip && (
        <>
          {/*
            What the transition blends in FROM, said plainly.

            None of these is an error — blending in from black on the first clip
            is a fade-in, and one of the commonest edits there is. This used to
            hide the whole panel in that case.
          */}
          <div className="px-3 pt-2 text-[10px] leading-snug text-ink-500">
            {!base
              ? 'Nothing is underneath, so this blends in from black — a fade-in.'
              : base.kind === 'layer'
                ? 'Revealing over the layer below. A grid mask brings this clip in square by square, showing the one underneath through the gaps.'
                : 'Blending in from the clip before it.'}
          </div>
          <div className="space-y-1.5 px-3 py-2">
            {/*
              How many there are, and why there are not more.

              The library is 400-odd mask wipes on top of eight built-ins, and
              when it failed to load the picker quietly showed the eight — four
              families instead of seven, with nothing anywhere saying so.
              Reported as the transitions having disappeared, which is exactly
              what it looks like from the outside.
            */}
            <div className="flex items-baseline justify-between text-[10px] text-ink-600">
              <span>
                {allTransitions.length} transition{allTransitions.length === 1 ? '' : 's'}
              </span>
              {transitionsError && (
                <span className="truncate pl-2 text-flame-400" title={transitionsError}>
                  library did not load
                </span>
              )}
            </div>

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
              {families.map(({ family, members }) => {
                const active = members.some((m) => m.id === clip.transitionIn?.id)
                return (
                  <button
                    key={family}
                    onClick={() => setTransition(clip.id, members[0].id)}
                    title={`${members.length} in this family`}
                    className={`flex items-center justify-between rounded px-2 py-1.5 text-[11px] capitalize transition-colors ${
                      active ? 'bg-flame-500 text-ink-950' : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                    }`}
                  >
                    <span>{family}</span>
                    <span className={active ? 'text-ink-950/60' : 'text-ink-600'}>
                      {members.length}
                    </span>
                  </button>
                )
              })}
            </div>

            {/*
              Filter by what a mask DOES, not what it is called.

              The library has 120 grid reveals and 122 blinds, and until they
              were measured the only way to find one was to already know it was
              called `luminous_boxes_17`. Tags come from the mask's own pixels.
            */}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => {
                  const members = transitionsWithTag(allTransitions, tag)
                  const on = tagFilter === tag
                  return (
                    <button
                      key={tag}
                      onClick={() => {
                        setTagFilter(on ? null : tag)
                        if (!on && members.length > 0) setTransition(clip.id, members[0].id)
                      }}
                      title={`${members.length} masks`}
                      className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                        on ? 'bg-flame-500 text-ink-950' : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                      }`}
                    >
                      {TAG_LABELS[tag]} <span className="opacity-60">{members.length}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {clip.transitionIn && (
              <>
                <select
                  value={clip.transitionIn.id}
                  onChange={(e) => setTransition(clip.id, e.target.value, clip.transitionIn?.durationFrames)}
                  className="w-full rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-200 outline-none"
                >
                  {tagFilter
                    ? transitionsWithTag(allTransitions, tagFilter).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))
                    : families.map(({ family, members }) => (
                        <optgroup key={family} label={family}>
                          {members.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </optgroup>
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
              {base?.kind === 'cut'
                ? 'A transition consumes time from both clips rather than adding any, so the timeline shortens.'
                : 'Nothing moves: there is no clip before this one to overlap, so this costs no time.'}
            </div>
          </div>
        </>
      )}

      </div>

      {jobs.length > 0 && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-ink-700 bg-ink-900">
          <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Exports</span>
            <button
              onClick={() => void window.forge.clearFinished()}
              className="text-[10px] text-ink-600 hover:text-ink-200"
            >
              Clear
            </button>
          </div>
          <div>
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
        </div>
      )}
    </div>
  )
}

