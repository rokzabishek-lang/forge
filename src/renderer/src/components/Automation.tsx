import { useState, type ReactNode } from 'react'
import { Film, Grid3x3, Layers, Loader2, Mic, Plus, Sparkles, Type, Wand2, Zap } from 'lucide-react'
import { PROP_RULE, generatedCount } from '@shared/automation/apply'
import { REEL_RULE } from '@shared/automation/reel'
import { FILMSTRIP_RULE } from '@shared/automation/filmstrip'
import { ONE_PHOTO_RULE } from '@shared/automation/onePhoto'
import {
  ARRIVAL_HINT,
  ARRIVAL_LABEL,
  CADENCES,
  CADENCE_LABEL,
  GRID_RULE,
  type Arrival
} from '@shared/automation/grid'
import {
  CELL_SHAPE_HINT,
  CELL_SHAPE_LABEL,
  REVEAL_ORDER_LABEL,
  gridFor,
  type CellShape,
  type RevealOrder
} from '@shared/render/grid'
import {
  STRIP_LOOK_HINT,
  STRIP_LOOK_LABEL,
  STRIP_RULE,
  type StripLook
} from '@shared/automation/strips'
import {
  STRIP_LAYOUT_HINT,
  STRIP_LAYOUT_LABEL,
  type StripLayout
} from '@shared/render/strips'
import { Music } from 'lucide-react'
import { useEditor } from '../store'
import { MusicRange } from './MusicRange'

/**
 * Automation toggles.
 *
 * Each rule writes ordinary clips onto the timeline, labelled with why it fired,
 * and clearing a rule removes exactly its own output. Nothing is hidden — that
 * is what keeps an automated edit auditable. See docs/AUTOMATION.md §6.
 */
export function Automation(): ReactNode {
  const project = useEditor((s) => s.project)
  const propsEnabled = useEditor((s) => s.propsEnabled)
  const propsPerMinute = useEditor((s) => s.propsPerMinute)
  const setPropsEnabled = useEditor((s) => s.setPropsEnabled)
  const setPropsPerMinute = useEditor((s) => s.setPropsPerMinute)
  const applyPropRule = useEditor((s) => s.applyPropRule)
  const buildReel = useEditor((s) => s.buildReel)
  const clearReel = useEditor((s) => s.clearReel)
  const reelBuilding = useEditor((s) => s.reelBuilding)
  const reelMotion = useEditor((s) => s.reelMotion)
  const setReelMotion = useEditor((s) => s.setReelMotion)
  const reelTransitions = useEditor((s) => s.reelTransitions)
  const setReelTransitions = useEditor((s) => s.setReelTransitions)
  const reelParallax = useEditor((s) => s.reelParallax)
  const setReelParallax = useEditor((s) => s.setReelParallax)
  const reelLyrics = useEditor((s) => s.reelLyrics)
  const setReelLyrics = useEditor((s) => s.setReelLyrics)
  const reelStage = useEditor((s) => s.reelStage)
  const cancelReel = useEditor((s) => s.cancelReel)
  const baking = useEditor((s) => s.baking)
  const buildFilmstrip = useEditor((s) => s.buildFilmstrip)
  const clearFilmstrip = useEditor((s) => s.clearFilmstrip)
  const filmstripPanels = useEditor((s) => s.filmstripPanels)
  const setFilmstripPanels = useEditor((s) => s.setFilmstripPanels)
  const filmstripSeconds = useEditor((s) => s.filmstripSeconds)
  const setFilmstripSeconds = useEditor((s) => s.setFilmstripSeconds)
  const importAssets = useEditor((s) => s.importAssets)
  const setAspect = useEditor((s) => s.setAspect)
  const clearPropRule = useEditor((s) => s.clearPropRule)
  const onePhotoCaption = useEditor((s) => s.onePhotoCaption)
  const setOnePhotoCaption = useEditor((s) => s.setOnePhotoCaption)
  const buildOnePhotoReel = useEditor((s) => s.buildOnePhotoReel)
  const clearOnePhotoReel = useEditor((s) => s.clearOnePhotoReel)
  const buildGrid = useEditor((s) => s.buildGrid)
  const clearGrid = useEditor((s) => s.clearGrid)
  const gridBuilding = useEditor((s) => s.gridBuilding)
  const gridPieces = useEditor((s) => s.gridPieces)
  const setGridPieces = useEditor((s) => s.setGridPieces)
  const gridShape = useEditor((s) => s.gridShape)
  const setGridShape = useEditor((s) => s.setGridShape)
  const gridOrder = useEditor((s) => s.gridOrder)
  const setGridOrder = useEditor((s) => s.setGridOrder)
  const gridArrival = useEditor((s) => s.gridArrival)
  const setGridArrival = useEditor((s) => s.setGridArrival)
  const gridGap = useEditor((s) => s.gridGap)
  const setGridGap = useEditor((s) => s.setGridGap)
  const gridTilt = useEditor((s) => s.gridTilt)
  const setGridTilt = useEditor((s) => s.setGridTilt)
  const gridBeatsPerCell = useEditor((s) => s.gridBeatsPerCell)
  const setGridBeatsPerCell = useEditor((s) => s.setGridBeatsPerCell)
  const buildStrips = useEditor((s) => s.buildStrips)
  const clearStrips = useEditor((s) => s.clearStrips)
  const stripsBuilding = useEditor((s) => s.stripsBuilding)
  const stripLayout = useEditor((s) => s.stripLayout)
  const setStripLayout = useEditor((s) => s.setStripLayout)
  const stripCount = useEditor((s) => s.stripCount)
  const setStripCount = useEditor((s) => s.setStripCount)
  const stripPerHit = useEditor((s) => s.stripPerHit)
  const setStripPerHit = useEditor((s) => s.setStripPerHit)
  const stripLook = useEditor((s) => s.stripLook)
  const setStripLook = useEditor((s) => s.setStripLook)
  const stripBeatsPerHit = useEditor((s) => s.stripBeatsPerHit)
  const setStripBeatsPerHit = useEditor((s) => s.setStripBeatsPerHit)
  const stripBursts = useEditor((s) => s.stripBursts)
  const setStripBursts = useEditor((s) => s.setStripBursts)

  const [running, setRunning] = useState(false)
  const [adding, setAdding] = useState(false)
  const placed = generatedCount(project, PROP_RULE)
  const transcribed = Object.keys(project.transcripts).length > 0
  const reelShots = generatedCount(project, REEL_RULE)
  const strips = generatedCount(project, FILMSTRIP_RULE)
  const images = project.assets.filter((a) => a.kind === 'image').length
  const onePhotoShots = generatedCount(project, ONE_PHOTO_RULE)
  const captionLines = onePhotoCaption.split('\n').filter((l) => l.trim()).length
  const gridClipCount = generatedCount(project, GRID_RULE)
  const stripClipCount = generatedCount(project, STRIP_RULE)
  // Shown before the build, so the shape of the grid is never a surprise: a
  // prime number of pieces can only be strips, and saying so up front is
  // kinder than letting someone pick 7 and wonder what happened.
  const { rows, cols } = gridFor(gridPieces, project.settings.width / project.settings.height)

  // The music clip on the timeline is the range the reel is built from, so the
  // panel shows that clip rather than keeping a second idea of "the music".
  const musicClip = project.clips.find((clip) => {
    const track = project.tracks.find((t) => t.id === clip.trackId)
    const asset = project.assets.find((a) => a.id === clip.assetId)
    return track?.kind === 'audio' && asset?.hasAudio
  })
  const musicAsset = musicClip
    ? project.assets.find((a) => a.id === musicClip.assetId) ?? null
    : null

  /*
   * Orientation mismatch, shown until it is fixed.
   *
   * This was a toast, and a toast is gone in a few seconds — two rendered reels
   * came back using a third of the frame with black bars either side because
   * the warning had already vanished by the time the reel was built. A standing
   * banner with the fix on it cannot be missed.
   */
  const photos = project.assets.filter((a) => a.kind === 'image')
  const portrait = photos.filter((a) => (a.height ?? 0) > (a.width ?? 1)).length
  const canvasPortrait = project.settings.height > project.settings.width
  const mismatch =
    photos.length === 0
      ? null
      : portrait > photos.length / 2 && !canvasPortrait
        ? ('9:16' as const)
        : portrait < photos.length / 2 && canvasPortrait
          ? ('16:9' as const)
          : null

  // What the sidecar is doing right now. A long bake with no message on screen
  // is indistinguishable from a hung app — which is exactly how it read.
  const bakeMessage = Object.values(baking)[0]?.message ?? null
  const bakeProgress = Object.values(baking)[0]?.progress ?? null

  const run = async (): Promise<void> => {
    setRunning(true)
    try {
      await applyPropRule()
    } finally {
      setRunning(false)
    }
  }

  const addMusic = async (): Promise<void> => {
    setAdding(true)
    try {
      const paths = await window.forge.pickMedia()
      if (paths.length > 0) await importAssets(paths)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-ink-900">
      <div className="border-b border-ink-800 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Automation
      </div>

      <section className="space-y-2 border-b border-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
            <Music size={12} className="text-flame-400" />
            Beat-synced reel
          </span>
          <span className="text-[10px] text-ink-600">{images} photo{images === 1 ? '' : 's'}</span>
        </div>

        <p className="text-[10.5px] leading-snug text-ink-600">
          Cuts your photos to the music — pacing set by tempo, treatment by how loud
          the moment is.
        </p>

        {musicClip && musicAsset ? (
          <MusicRange clip={musicClip} asset={musicAsset} />
        ) : (
          <button
            onClick={() => void addMusic()}
            disabled={adding}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-ink-700 px-2 py-3 text-[11px] text-ink-400 hover:border-flame-500 hover:text-ink-200 disabled:opacity-40"
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Add music
          </button>
        )}

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Motion</span>
          <input
            type="range"
            min={0}
            max={35}
            step={1}
            value={Math.round(reelMotion * 100)}
            onChange={(e) => setReelMotion(Number(e.target.value) / 100)}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {reelMotion === 0 ? 'none' : `${Math.round(reelMotion * 100)}%`}
          </span>
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-ink-850">
          <input
            type="checkbox"
            checked={reelParallax}
            onChange={(e) => setReelParallax(e.target.checked)}
            className="mt-0.5 shrink-0 accent-flame-500"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-200">
              <Layers size={11} className="text-flame-400" />
              Depth parallax
            </span>
            <span className="mt-0.5 block text-[10px] leading-snug text-ink-600">
              Cuts each photo into depth planes so near things move faster than far
              ones. Takes a few seconds per photo the first time, then it is cached.
              Photos too flat to separate keep the ordinary move.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-ink-850">
          <input
            type="checkbox"
            checked={reelLyrics}
            onChange={(e) => setReelLyrics(e.target.checked)}
            className="mt-0.5 shrink-0 accent-flame-500"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-200">
              <Mic size={11} className="text-flame-400" />
              Cut to the words
            </span>
            <span className="mt-0.5 block text-[10px] leading-snug text-ink-600">
              Splits the song, reads the vocal, and puts cuts on the words that
              land hardest — a “b” or a “t” has a real attack in it, where a
              word starting on a vowel has none. Kept where they were sung
              rather than dragged onto the beat, which is the whole point.
              Instrumental tracks fall back to beats on their own.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Transitions</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(reelTransitions * 100)}
            onChange={(e) => setReelTransitions(Number(e.target.value) / 100)}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {reelTransitions === 0 ? 'cuts' : `${Math.round(reelTransitions * 100)}%`}
          </span>
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => void buildReel()}
            disabled={reelBuilding || gridBuilding || images === 0 || !musicClip}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
          >
            {reelBuilding ? <Loader2 size={12} className="animate-spin" /> : <Music size={12} />}
            {reelBuilding ? reelStage ?? 'Analysing' : reelShots > 0 ? 'Rebuild' : 'Analyse & build'}
          </button>
          {reelBuilding && (
            <button
              onClick={cancelReel}
              className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
            >
              Stop
            </button>
          )}
          {!reelBuilding && reelShots > 0 && (
            <button
              onClick={clearReel}
              className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
            >
              Clear
            </button>
          )}
        </div>

        {reelBuilding && (
          <div className="space-y-1 rounded bg-ink-950/60 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[10.5px] text-ink-300">
                {bakeMessage ?? reelStage ?? 'analysing the music'}
              </span>
              {reelStage && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-600">
                  {reelStage}
                </span>
              )}
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-ink-800">
              <div
                className={`h-full bg-flame-500 ${bakeProgress === null ? 'w-1/3 animate-pulse' : ''}`}
                style={bakeProgress === null ? undefined : { width: `${Math.round(bakeProgress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {mismatch && (
          <div className="space-y-1 rounded border border-amber-600/40 bg-amber-500/10 p-2">
            <div className="text-[10.5px] leading-snug text-amber-400">
              {mismatch === '9:16'
                ? `${portrait} of your ${photos.length} photos are portrait but the canvas is landscape — they will sit in a narrow strip with black either side.`
                : `Most of your photos are landscape but the canvas is vertical — they will sit in a band with black above and below.`}
            </div>
            <button
              onClick={() => setAspect(mismatch)}
              className="w-full rounded bg-amber-500 px-2 py-1 text-[10.5px] font-medium text-ink-950 hover:bg-amber-400"
            >
              Switch the canvas to {mismatch}
            </button>
          </div>
        )}

        {musicClip && images === 0 && (
          <div className="text-[10.5px] leading-snug text-amber-500">
            Import some photos — they are what the cuts are made of.
          </div>
        )}
        {reelShots > 0 && (
          <div className="text-[10.5px] text-emerald-400">
            {reelShots} shots placed. Every one is an ordinary clip.
          </div>
        )}
      </section>

      <section className="space-y-2 border-b border-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
            <Type size={12} className="text-flame-400" />
            One photo
          </span>
          <span className="text-[10px] text-ink-600">
            {onePhotoShots > 0 ? `${onePhotoShots} shots` : 'photo + song + words'}
          </span>
        </div>

        <p className="text-[10.5px] leading-snug text-ink-600">
          One picture becomes several shots — wide, medium, close on the face — cut
          on the bar. Type your caption and it is split into cards sized to fit the
          tempo, each landing on a downbeat.
        </p>

        <textarea
          value={onePhotoCaption}
          onChange={(e) => setOnePhotoCaption(e.target.value)}
          rows={3}
          placeholder={'she said yes\nand we cried\nbest day of my life'}
          className="w-full resize-none rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-[11px] text-ink-200 placeholder:text-ink-700 focus:border-flame-500 focus:outline-none"
        />
        <div className="flex items-center justify-between text-[10px] text-ink-600">
          <span>One line per card. Long lines split themselves.</span>
          {onePhotoCaption.trim() && <span>{captionLines} line{captionLines === 1 ? '' : 's'}</span>}
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => void buildOnePhotoReel()}
            disabled={reelBuilding || gridBuilding || images === 0 || !musicClip}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
          >
            {reelBuilding ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {reelBuilding ? reelStage ?? 'Working' : onePhotoShots > 0 ? 'Rebuild' : 'Build from one photo'}
          </button>
          {!reelBuilding && onePhotoShots > 0 && (
            <button
              onClick={clearOnePhotoReel}
              className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
            >
              Clear
            </button>
          )}
        </div>

        <div className="text-[10px] leading-snug text-ink-600">
          Uses the selected photo, or the first one. It bakes the subject cutout
          first — that is what lets a close-up land on a face rather than a waist.
        </div>
      </section>

      <section className="space-y-2 border-b border-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
            <Grid3x3 size={12} className="text-flame-400" />
            Grid split
          </span>
          <span className="text-[10px] text-ink-600">
            {gridClipCount > 0 ? `${gridClipCount} pieces` : `${rows} × ${cols}`}
          </span>
        </div>

        <p className="text-[10.5px] leading-snug text-ink-600">
          One photo cut into pieces that arrive one per beat, until the picture is
          whole. This is the one place cutting on every beat is right — the frame
          is not changing, it is filling in.
        </p>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Pieces</span>
          <input
            type="range"
            min={2}
            max={36}
            step={1}
            value={gridPieces}
            onChange={(e) => setGridPieces(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {rows} × {cols}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(CELL_SHAPE_LABEL) as CellShape[]).map((shape) => (
            <button
              key={shape}
              onClick={() => setGridShape(shape)}
              title={CELL_SHAPE_HINT[shape]}
              className={`rounded px-1.5 py-1 text-[10.5px] transition-colors ${
                gridShape === shape
                  ? 'bg-flame-500 text-ink-950'
                  : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
              }`}
            >
              {CELL_SHAPE_LABEL[shape]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Order</span>
          <select
            value={gridOrder}
            onChange={(e) => setGridOrder(e.target.value as RevealOrder)}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-[10.5px] text-ink-200 focus:border-flame-500 focus:outline-none"
          >
            {(Object.keys(REVEAL_ORDER_LABEL) as RevealOrder[]).map((order) => (
              <option key={order} value={order}>
                {REVEAL_ORDER_LABEL[order]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Landing</span>
          <select
            value={gridArrival}
            onChange={(e) => setGridArrival(e.target.value as Arrival)}
            title={ARRIVAL_HINT[gridArrival]}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-[10.5px] text-ink-200 focus:border-flame-500 focus:outline-none"
          >
            {(Object.keys(ARRIVAL_LABEL) as Arrival[]).map((arrival) => (
              <option key={arrival} value={arrival}>
                {ARRIVAL_LABEL[arrival]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Cadence</span>
          <select
            value={gridBeatsPerCell}
            onChange={(e) => setGridBeatsPerCell(Number(e.target.value))}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-[10.5px] text-ink-200 focus:border-flame-500 focus:outline-none"
          >
            {CADENCES.map((rate) => (
              <option key={rate} value={rate}>
                {CADENCE_LABEL[rate]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Gutter</span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={Math.round(gridGap * 100)}
            onChange={(e) => setGridGap(Number(e.target.value) / 100)}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {gridGap === 0 ? 'none' : `${Math.round(gridGap * 100)}%`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Tilt</span>
          <input
            type="range"
            min={0}
            max={25}
            step={1}
            value={gridTilt}
            onChange={(e) => setGridTilt(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {gridTilt === 0 ? 'square' : `±${gridTilt}°`}
          </span>
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => void buildGrid()}
            // Also while the reel is analysing: both rules write onto a video
            // lane anchored at the music, and letting them race meant whichever
            // finished second was silently shoved past the other's output.
            disabled={gridBuilding || reelBuilding || images === 0}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
          >
            {gridBuilding ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Grid3x3 size={12} />
            )}
            {gridClipCount > 0 ? 'Rebuild grid' : 'Build grid'}
          </button>
          {!gridBuilding && gridClipCount > 0 && (
            <button
              onClick={clearGrid}
              className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
            >
              Clear
            </button>
          )}
        </div>

        <div className="text-[10px] leading-snug text-ink-600">
          {musicClip
            ? 'Uses the selected photo, or the first one, and lands the pieces on the track’s beats.'
            : 'No music on the timeline — the pieces will arrive on an even cadence instead.'}
        </div>
      </section>

      <section className="space-y-2 border-b border-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
            <Zap size={12} className="text-flame-400" />
            Strip flashes
          </span>
          <span className="text-[10px] text-ink-600">
            {stripClipCount > 0 ? `${stripClipCount} flashes` : 'over the shot'}
          </span>
        </div>

        <p className="text-[10.5px] leading-snug text-ink-600">
          Slices of a brightened copy flashing over the shot that is already
          there — four a beat. The footage never stops; only the slices change,
          which is why this can run far faster than a cut ever should.
        </p>

        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(STRIP_LAYOUT_LABEL) as StripLayout[]).map((layout) => (
            <button
              key={layout}
              onClick={() => setStripLayout(layout)}
              title={STRIP_LAYOUT_HINT[layout]}
              className={`rounded px-1.5 py-1 text-[10.5px] transition-colors ${
                stripLayout === layout
                  ? 'bg-flame-500 text-ink-950'
                  : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
              }`}
            >
              {STRIP_LAYOUT_LABEL[layout]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Slices</span>
          <input
            type="range"
            min={2}
            max={12}
            step={1}
            value={stripCount}
            onChange={(e) => setStripCount(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {stripCount}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">At once</span>
          <input
            type="range"
            min={1}
            max={6}
            step={1}
            value={stripPerHit}
            onChange={(e) => setStripPerHit(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {stripPerHit}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Rate</span>
          <select
            value={stripBeatsPerHit}
            onChange={(e) => setStripBeatsPerHit(Number(e.target.value))}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-[10.5px] text-ink-200 focus:border-flame-500 focus:outline-none"
          >
            {CADENCES.filter((r) => r <= 4).map((rate) => (
              <option key={rate} value={rate}>
                {CADENCE_LABEL[rate]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Look</span>
          <select
            value={stripLook}
            onChange={(e) => setStripLook(e.target.value as StripLook)}
            title={STRIP_LOOK_HINT[stripLook]}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-[10.5px] text-ink-200 focus:border-flame-500 focus:outline-none"
          >
            {(Object.keys(STRIP_LOOK_LABEL) as StripLook[]).map((look) => (
              <option key={look} value={look}>
                {STRIP_LOOK_LABEL[look]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Stutters</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(stripBursts * 100)}
            onChange={(e) => setStripBursts(Number(e.target.value) / 100)}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {stripBursts === 0 ? 'none' : `${Math.round(stripBursts * 100)}%`}
          </span>
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => void buildStrips()}
            disabled={stripsBuilding || reelBuilding || gridBuilding}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
          >
            {stripsBuilding ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {stripClipCount > 0 ? 'Rebuild flashes' : 'Add flashes'}
          </button>
          {!stripsBuilding && stripClipCount > 0 && (
            <button
              onClick={clearStrips}
              className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
            >
              Clear
            </button>
          )}
        </div>

        <div className="text-[10px] leading-snug text-ink-600">
          Uses the shot under the playhead and lays the flashes on the track
          above it. Every one is an ordinary clip — delete them all and the shot
          is exactly as it was.
        </div>
      </section>

      <section className="space-y-2 border-b border-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
            <Film size={12} className="text-flame-400" />
            Filmstrip
          </span>
          <span className="text-[10px] text-ink-600">at the playhead</span>
        </div>
        <p className="text-[10.5px] leading-snug text-ink-600">
          Your photos as full-height panels in one long row, panning across frame.
          Every panel is an ordinary clip with its own path.
        </p>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Panels</span>
          <input
            type="range"
            min={2}
            max={8}
            step={1}
            value={filmstripPanels}
            onChange={(e) => setFilmstripPanels(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {filmstripPanels} wide
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Length</span>
          <input
            type="range"
            min={1}
            max={12}
            step={0.5}
            value={filmstripSeconds}
            onChange={(e) => setFilmstripSeconds(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
            {filmstripSeconds}s
          </span>
        </div>

        <div className="flex gap-1">
          <button
            onClick={buildFilmstrip}
            disabled={images === 0}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
          >
            <Film size={12} />
            {strips > 0 ? 'Rebuild strip' : 'Build strip'}
          </button>
          {strips > 0 && (
            <button
              onClick={clearFilmstrip}
              className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
            >
              Clear
            </button>
          )}
        </div>
        {strips > 0 && (
          <div className="text-[10.5px] text-emerald-400">{strips} panels placed.</div>
        )}
      </section>

      <section className="space-y-2 border-b border-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
            <Sparkles size={12} className="text-flame-400" />
            3D props on keywords
          </span>
          <button
            onClick={() => setPropsEnabled(!propsEnabled)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              propsEnabled ? 'bg-flame-500 text-ink-950' : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
            }`}
          >
            {propsEnabled ? 'On' : 'Off'}
          </button>
        </div>

        <p className="text-[10.5px] leading-snug text-ink-600">
          Props appear when a matching word is spoken — fire on “flame”, rocket on
          “launch”. No model involved: the transcript already has word timing.
        </p>

        {propsEnabled && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[10.5px] text-ink-400">Frequency</span>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={propsPerMinute}
                onChange={(e) => setPropsPerMinute(Number(e.target.value))}
                className="min-w-0 flex-1"
              />
              <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-600">
                {propsPerMinute}/min
              </span>
            </div>

            <div className="flex gap-1">
              <button
                onClick={() => void run()}
                disabled={running || !transcribed}
                className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                {placed > 0 ? 'Regenerate' : 'Place props'}
              </button>
              {placed > 0 && (
                <button
                  onClick={clearPropRule}
                  className="rounded bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                >
                  Clear
                </button>
              )}
            </div>

            {!transcribed && (
              <div className="text-[10.5px] leading-snug text-amber-500">
                Transcribe a clip first — props fire on spoken words.
              </div>
            )}

            {placed > 0 && (
              <div className="text-[10.5px] text-emerald-400">
                {placed} placed. They are ordinary clips — move, trim or delete any of them.
              </div>
            )}
          </>
        )}
      </section>

      {placed > 0 && (
        <section className="p-3">
          <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-ink-600">Why these fired</div>
          <div className="space-y-1">
            {project.clips
              .filter((c) => c.generatedBy?.rule === PROP_RULE)
              .slice(0, 12)
              .map((clip) => (
                <div key={clip.id} className="truncate text-[10.5px] text-ink-400">
                  {clip.generatedBy?.reason}
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}
