import { create } from 'zustand'
import type { Job } from '@shared/types'
import { samePath } from '@shared/assetPath'
import type {
  Clip,
  ColorAdjust,
  CropRect,
  MediaAsset,
  ParallaxBake,
  PathPoint,
  Project,
  SolidSpec,
  TextSpec
} from '@shared/timeline'
import { DEFAULT_COLOR, DEFAULT_TEXT, clipCoversFrame } from '@shared/timeline'
import type { Mask, MaskShape } from '@shared/render/mask'
import { clipSpeed, maxDurationAtSpeed, withClipSpeed } from '@shared/render/speed'
import { normalisePath, pathAt } from '@shared/render/path'
import { normaliseKeys, type Ease, type Keyframe, type KeyedProperty } from '@shared/render/keyframes'
import { transitionById } from '@shared/transitions/registry'
import { entriesOfKind } from '@shared/assets/catalog'
import { DEFAULT_TRIGGER_OPTIONS, tagsForProp } from '@shared/automation/keywords'
import { safeCrop } from '@shared/render/crop'
import { ASPECTS, aspectOf, type AspectKey } from '@shared/render/aspect'
import {
  PROP_RULE,
  clearGenerated,
  makeGeneratedClip,
  overlayTrackFor,
  planPropClips
} from '@shared/automation/apply'
import {
  ONE_PHOTO_RULE,
  ONE_PHOTO_CAPTION_RULE,
  onePhotoClips,
  planOnePhotoReel
} from '@shared/automation/onePhoto'
import {
  REEL_RULE,
  DEFAULT_MOTION_AMOUNT,
  DEFAULT_REEL_TRANSITION_RATE,
  planReel,
  reelClips
} from '@shared/automation/reel'
import { pickTransition } from '@shared/automation/cutPlan'
import { accentsFrom } from '@shared/automation/lyrics'
import { sandwich, unsandwich } from '@shared/automation/sandwich'
import {
  DEFAULT_VISIBLE,
  FILMSTRIP_RULE,
  filmstripClips,
  planFilmstrip
} from '@shared/automation/filmstrip'
import {
  GRID_RULE,
  gridClips,
  planGridSplit,
  type Arrival
} from '@shared/automation/grid'
import {
  DEFAULT_GRID,
  gridFor,
  type CellShape,
  type RevealOrder
} from '@shared/render/grid'
import {
  DEFAULT_BEATS_PER_HIT,
  DEFAULT_BURST_RATE,
  DEFAULT_STRIP_COUNT,
  STRIP_RULE,
  planStrips,
  stripClips,
  type StripLook
} from '@shared/automation/strips'
import type { StripLayout } from '@shared/render/strips'
import {
  addTransition as addTransitionTo,
  anchorTransition as anchorTransitionOn,
  removeTransition as removeTransitionFrom,
  addTrack as addTrackTo,
  clipEnd,
  clipsOnTrack,
  emptyProject,
  findFreeSlot,
  overlapsOn,
  stackedSlot,
  trackLimitReached,
  transitionBase,
  framesToSeconds,
  secondsToFrames,
  projectDuration,
  removeTrack as removeTrackFrom,
  splitClip,
  trimEnd,
  trimStart
} from '@shared/timeline'
import { useCatalog } from './catalog'
import { bakeText, bakeTextSequence } from './textCanvas'
import {
  DEFAULT_PIP,
  pipTransform,
  splitTransform,
  type PipOptions,
  type SplitLayout
} from '@shared/render/layout'
import type { DecisionRecord } from '@shared/project'
import type { Transcript } from '@shared/transcript'

/*
 * Re-exported so every existing import keeps working; the table itself moved to
 * shared, where the render plan and the crop solver can reach it too.
 */
export { ASPECTS, aspectOf, type AspectKey } from '@shared/render/aspect'

/** What dragging on the preview does. */
export type PreviewTool = 'select' | 'crop' | 'mask'

/** Where material comes from. Only `upload` is built; see SourceBar. */
export type SourceMode = 'upload' | 'youtube' | 'narration'

/**
 * Text edits in flight, coalesced per clip.
 *
 * Redrawing the PNG is an IPC round trip through a rasteriser, so a keystroke
 * or a mouse-move each doing one is far more work than anybody can see.
 */
const TEXT_COALESCE_MS = 160
const pendingText = new Map<string, { spec: TextSpec; timer: ReturnType<typeof setTimeout> }>()

/**
 * The largest rectangle of the target aspect that fits inside the source,
 * centred. This is the placeholder auto-reframe: it is what CV speaker-tracking
 * will replace, and what the user drags to fix when it lands on the wrong person.
 */
export function solveCrop(asset: MediaAsset, aspect: AspectKey): CropRect | undefined {
  const source = { w: asset.width ?? 0, h: asset.height ?? 0 }
  if (source.w <= 0 || source.h <= 0) return undefined

  const target = ASPECTS[aspect]
  const targetRatio = target.width / target.height
  const sourceRatio = source.w / source.h

  // Already the right shape — no crop needed.
  if (Math.abs(targetRatio - sourceRatio) < 0.001) return undefined

  const width = targetRatio < sourceRatio ? Math.round(source.h * targetRatio) : source.w
  const height = targetRatio < sourceRatio ? source.h : Math.round(source.w / targetRatio)

  /*
   * Clamped on the way out, not just on the way into ffmpeg.
   *
   * These two roundings can each land a pixel over the source — and the render
   * used to round them UP again to make them even, which is how an export died
   * on "Invalid too big or non positive size for width '3210'". Swept over every
   * realistic source size and all three aspects, HALF of them came out reaching
   * outside the frame. The renderer clamps too, but a crop that is wrong the
   * moment it is stored is also a crop the on-picture handles draw wrongly.
   */
  return (
    safeCrop(
      {
        x: Math.round((source.w - width) / 2),
        y: Math.round((source.h - height) / 2),
        width,
        height
      },
      { width: source.w, height: source.h }
    ) ?? undefined
  )
}

/**
 * Room for an overlay at a moment, found by going UP rather than along.
 *
 * Two clips on one track are a sequence — that is what a track IS — so
 * `findFreeSlot` slides a colliding clip later until it fits, which is right for
 * a cut and wrong for anything meant to sit ON something. A second line of text,
 * a sticker over a face, a colour wash: those are layers, and a layer that
 * silently jumped three seconds into the future is a layer nobody asked for.
 *
 * So the time stays put and the track climbs, adding one at the top when every
 * existing track is busy. At the track ceiling it gives up and slides, because
 * landing somewhere odd still beats refusing to add the clip at all.
 */
function stackOverlay(
  project: Project,
  trackId: string,
  startFrame: number,
  duration: number
): { project: Project; trackId: string; start: number } {
  const desired = Math.max(0, startFrame)

  const found = stackedSlot(project, trackId, desired, duration)
  if (found) return { project, trackId: found.trackId, start: found.start }

  const kind = project.tracks.find((t) => t.id === trackId)?.kind ?? 'video'
  if (!trackLimitReached(project)) {
    const grown = addTrackTo(project, kind)
    const lanes = grown.tracks.filter((t) => t.kind === kind)
    const added = lanes[lanes.length - 1]
    if (added && added.id !== trackId) {
      return { project: grown, trackId: added.id, start: desired }
    }
  }

  return { project, trackId, start: findFreeSlot(project, trackId, desired, duration) }
}

/**
 * Dragging a slider over an existing key must not silently reset its easing —
 * the value is what changed, not the shape of the curve leaving it.
 */
function keepEase(existing: Keyframe[], frame: number): { ease?: Ease } {
  const previous = existing.find((k) => k.frame === frame)
  return previous?.ease ? { ease: previous.ease } : {}
}

export interface Notice {
  id: number
  text: string
  tone: 'error' | 'info'
}

interface EditorState {
  project: Project
  projectPath: string | null
  decisions: DecisionRecord[]
  dirty: boolean

  playhead: number
  playing: boolean
  selectedClipId: string | null
  /** Timeline horizontal scale, in pixels per frame. */
  zoom: number
  aspect: AspectKey
  /** Preview shows the source frame with the crop outlined, or the final output. */
  previewMode: 'source' | 'output'

  /**
   * What the pointer does on the picture.
   *
   * `select` moves and scales the clip; `crop` drags the reframe rectangle,
   * which was previously reachable only by opening the split view — an odd
   * place for it, since reframing has nothing to do with comparing.
   */
  previewTool: PreviewTool
  setPreviewTool: (tool: PreviewTool) => void
  /** Rule-of-thirds guides over the picture. */
  showThirds: boolean
  /** Title-safe and action-safe rectangles, per SMPTE ST 2046-1. */
  showSafe: boolean
  toggleGuide: (guide: 'thirds' | 'safe') => void
  /** Which way material comes in. */
  sourceMode: SourceMode
  setSourceMode: (mode: SourceMode) => void

  jobs: Job[]
  notices: Notice[]

  /** Per-asset transcription progress; presence means "in flight". */
  transcribing: Record<string, { progress: number | null; message?: string }>
  /** Per-asset depth-bake progress; presence means "in flight". */
  baking: Record<string, { progress: number | null; message?: string }>
  sidecarReady: boolean
  sidecarError: string | null

  past: Project[]
  future: Project[]

  notify: (text: string, tone?: Notice['tone']) => void
  dismissNotice: (id: number) => void

  begin: () => void
  commit: () => void
  update: (recipe: (project: Project) => Project) => void
  undo: () => void
  redo: () => void

  importAssets: (paths: string[]) => Promise<void>
  addAssetToTimeline: (assetId: string) => void
  removeClip: (clipId: string) => void
  moveClip: (clipId: string, start: number, trackId?: string) => void
  trimClipStart: (clipId: string, start: number) => void
  trimClipEnd: (clipId: string, end: number) => void
  splitAtPlayhead: () => void
  setCrop: (clipId: string, crop: CropRect) => void
  setAspect: (aspect: AspectKey) => void
  /** Redraw text, colour cards and titles at the current canvas size. */
  rebakeGenerated: () => Promise<void>
  /**
   * An asset being auditioned from the library, independent of the timeline.
   * The waveform shows this when no clip is selected, so an SFX can be heard and
   * trimmed before it is ever placed.
   */
  audition: { path: string; name: string; inMs: number; outMs: number } | null
  setAudition: (audition: { path: string; name: string } | null) => void
  setAuditionRange: (inMs: number, outMs: number) => void
  /** Import the auditioned file and place its trimmed range at the playhead. */
  addAuditionToTimeline: () => Promise<void>
  /** Beat-synced reel from stills. */
  reelBuilding: boolean
  reelMotion: number
  setReelMotion: (amount: number) => void
  /** 0 = every cut hard, 1 = every cut treated. */
  reelTransitions: number
  setReelTransitions: (rate: number) => void
  /** Bake depth planes so photos move with parallax rather than flat. */
  reelParallax: boolean
  setReelParallax: (on: boolean) => void
  /**
   * Cut to the sung word as well as to the beat.
   *
   * Splits the song, reads the vocal, and hands the hard-landing words to the
   * planner alongside the grid. See shared/automation/lyrics.ts.
   */
  reelLyrics: boolean
  setReelLyrics: (on: boolean) => void
  /** What a long build is doing right now, e.g. "depth 4/18". */
  reelStage: string | null
  reelCancelled: boolean
  cancelReel: () => void
  buildReel: () => Promise<void>
  clearReel: () => void

  /**
   * One photograph, one song, one caption.
   *
   * A separate product from the multi-photo reel because the constraint is
   * different: with nothing to cut *to*, the framing, the camera and the words
   * have to manufacture every change.
   */
  onePhotoCaption: string
  setOnePhotoCaption: (caption: string) => void
  buildOnePhotoReel: (assetId?: string) => Promise<void>
  clearOnePhotoReel: () => void

  /** Automation rule settings, persisted with nothing — they drive generation. */
  propsEnabled: boolean
  propsPerMinute: number
  setPropsEnabled: (enabled: boolean) => void
  setPropsPerMinute: (rate: number) => void
  applyPropRule: () => Promise<void>
  clearPropRule: () => void

  /** Write plain text — no template needed. Returns the new clip's id. */
  addTextClip: (trackId: string, startFrame: number) => Promise<string | null>
  setText: (clipId: string, patch: Partial<Omit<TextSpec, 'version'>>) => Promise<void>
  /** A flat card of colour, for text to sit on or as a wash between shots. */
  addSolidClip: (trackId: string, startFrame: number) => Promise<string | null>
  /** A grade over everything on the tracks below, for as long as it runs. */
  addAdjustmentLayer: (trackId: string, startFrame: number) => Promise<string | null>
  setSolid: (clipId: string, patch: Partial<Omit<SolidSpec, 'version'>>) => Promise<void>
  /** Drop a title template onto a track, rendered from its own placeholders. */
  placeTitle: (template: string, name: string, trackId: string, startFrame: number) => Promise<void>
  setTitleText: (clipId: string, index: number, text: string) => Promise<void>
  /** Drop a library asset onto a track at a frame. */
  placeLibraryAsset: (
    file: string,
    name: string,
    trackId: string,
    startFrame: number
  ) => Promise<void>

  /** Trim in SOURCE frames — what the waveform trimmer manipulates. */
  setSourceRange: (clipId: string, inPoint: number, outPoint: number) => void
  /** Size, position and opacity of a clip within the frame. */
  setTransform: (clipId: string, patch: Partial<Clip['transform']>) => void
  /** Brightness, contrast, saturation and the LUT on top of them. */
  setColor: (clipId: string, patch: Partial<ColorAdjust>) => void
  /**
   * The shape on the picture, and what happens inside it.
   *
   * `undefined` removes it — a mask nobody can see the edges of is worse than
   * no mask, so the way out has to be as plain as the way in.
   */
  splitWithClipBelow: (clipId: string, layout: SplitLayout) => void
  makePip: (
    clipId: string,
    options: Partial<Omit<PipOptions, 'canvas'>> & { radius?: number }
  ) => void
  setMask: (clipId: string, mask: Mask | undefined) => void
  /** Change part of a mask's shape without restating the rest of it. */
  setMaskShape: (clipId: string, patch: Partial<MaskShape>) => void
  /** Open the file dialog and put the chosen .cube on this clip. */
  chooseLut: (clipId: string) => Promise<void>
  /** How long a clip stays on screen, in frames. */
  setClipDuration: (clipId: string, frames: number) => void
  /**
   * Slow motion and fast motion.
   *
   * Keeps the same footage and changes how long the clip sits on the timeline,
   * rippling whatever follows it on that track so nothing silently collides.
   */
  setClipSpeed: (clipId: string, speed: number, smoothSlow?: boolean) => void
  /** Animated position. Undefined clears it. */
  setPath: (clipId: string, path: PathPoint[] | undefined) => void
  /** Write a key at a frame, replacing one already there. */
  setKeyframe: (
    clipId: string,
    property: KeyedProperty,
    frame: number,
    value: number,
    ease?: Ease
  ) => void
  removeKeyframe: (clipId: string, property: KeyedProperty, frame: number) => void
  /** Replace a whole track at once — what the curve editor writes. */
  setKeyframes: (clipId: string, property: KeyedProperty, keys: Keyframe[]) => void
  clearKeyframes: (clipId: string, property: KeyedProperty) => void
  /** Put this clip behind the subject of the photo beneath it. */
  putBehindSubject: (clipId: string) => void
  /** Show the clip underneath through the shape of this one. */
  fillWithClipBelow: (clipId: string) => void
  /** Undo that: both clips go back to being ordinary. */
  releaseMatte: (clipId: string) => void
  /** Lay the photos out as a sliding row of panels at the playhead. */
  buildFilmstrip: () => void
  clearFilmstrip: () => void
  filmstripPanels: number
  setFilmstripPanels: (n: number) => void
  filmstripSeconds: number
  setFilmstripSeconds: (s: number) => void

  /**
   * Cut one photograph into pieces that arrive on the beat.
   *
   * Takes the music on the timeline when there is any, and an even cadence when
   * there is not. Sheet ① — see shared/render/grid.ts.
   */
  buildGrid: (assetId?: string) => Promise<void>
  clearGrid: () => void
  gridPieces: number
  setGridPieces: (n: number) => void
  gridShape: CellShape
  setGridShape: (shape: CellShape) => void
  gridOrder: RevealOrder
  setGridOrder: (order: RevealOrder) => void
  gridArrival: Arrival
  setGridArrival: (arrival: Arrival) => void
  gridGap: number
  setGridGap: (gap: number) => void
  gridTilt: number
  setGridTilt: (tilt: number) => void
  gridBeatsPerCell: number
  setGridBeatsPerCell: (beats: number) => void
  gridBuilding: boolean

  /**
   * Slices of a brightened copy flashing over the shot that is already there.
   *
   * The other half of the reference template — see shared/automation/strips.ts.
   * Writes only the flashes; the footage underneath is untouched.
   */
  buildStrips: () => Promise<void>
  clearStrips: () => void
  stripLayout: StripLayout
  setStripLayout: (layout: StripLayout) => void
  stripCount: number
  setStripCount: (n: number) => void
  stripPerHit: number
  setStripPerHit: (n: number) => void
  stripLook: StripLook
  setStripLook: (look: StripLook) => void
  stripBeatsPerHit: number
  setStripBeatsPerHit: (beats: number) => void
  stripBursts: number
  setStripBursts: (rate: number) => void
  stripsBuilding: boolean
  removeSandwich: (frontClipId: string) => void
  /** Capture the clip's current resting position as a waypoint at the playhead. */
  addWaypoint: (clipId: string) => void
  setTransition: (clipId: string, transitionId: string, durationFrames?: number) => void
  clearTransition: (clipId: string) => void
  addTrack: (kind: 'video' | 'audio') => void
  removeTrack: (trackId: string) => void
  toggleTrackMuted: (trackId: string) => void
  toggleTrackHidden: (trackId: string) => void
  setCaptionStyle: (styleId: string) => void
  setCaptionsEnabled: (enabled: boolean) => void
  setCaptionOverride: (key: string, value: unknown) => void
  clearCaptionOverrides: () => void
  /** 0 = all output, 1 = all source, anything between splits the preview. */
  splitRatio: number
  setSplitRatio: (ratio: number) => void

  setPlayhead: (frame: number) => void
  setPlaying: (playing: boolean) => void
  loop: boolean
  setLoop: (loop: boolean) => void
  select: (clipId: string | null) => void
  /**
   * Select a clip AND make sure it is on screen.
   *
   * What every "add" should call. Selecting alone is not enough: a clip that
   * does not sit under the playhead is not drawn, so it has no handles to grab.
   */
  revealClip: (clipId: string) => void
  setZoom: (zoom: number) => void
  setPreviewMode: (mode: 'source' | 'output') => void

  setJobs: (jobs: Job[]) => void
  transcribeAsset: (assetId: string) => Promise<void>
  /** Cut a photo into depth planes for parallax. Returns null on failure. */
  bakeParallax: (assetId: string) => Promise<ParallaxBake | null>
  cancelBake: (assetId: string) => void
  setBakeProgress: (assetId: string, progress: number | null, message?: string) => void
  cancelTranscribe: (assetId: string) => void
  setTranscribeProgress: (assetId: string, progress: number | null, message?: string) => void
  setSidecar: (ready: boolean, error?: string | null) => void
  newProject: () => void
  loadProject: (project: Project, path: string, decisions: DecisionRecord[]) => void
  markSaved: (path: string) => void
}

const HISTORY_LIMIT = 100
let noticeId = 0

export const useEditor = create<EditorState>((set, get) => ({
  project: emptyProject(),
  projectPath: null,
  decisions: [],
  dirty: false,

  playhead: 0,
  playing: false,
  loop: false,
  selectedClipId: null,
  zoom: 0.6,
  aspect: '16:9',
  previewMode: 'source',
  previewTool: 'select',
  setPreviewTool: (previewTool) => set({ previewTool }),
  showThirds: false,
  showSafe: false,
  toggleGuide: (guide) =>
    set((state) => (guide === 'thirds' ? { showThirds: !state.showThirds } : { showSafe: !state.showSafe })),
  sourceMode: 'upload',
  setSourceMode: (sourceMode) => set({ sourceMode }),
  /*
   * The preview shows the OUTPUT by default.
   *
   * It used to open on the source view, where motion, crop and transitions are
   * all deliberately absent — so a reel full of camera moves sat perfectly
   * still and looked broken. The source view is a correction surface you pull
   * in when something is wrong, not the thing you watch.
   */
  splitRatio: 0,

  jobs: [],
  notices: [],

  transcribing: {},
  baking: {},
  sidecarReady: false,
  sidecarError: null,

  past: [],
  future: [],

  notify: (text, tone = 'error') =>
    set((s) => ({ notices: [...s.notices, { id: ++noticeId, text, tone }] })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  /**
   * Transactions exist so a pointer drag is one undo step. begin() snapshots,
   * update() mutates freely, commit() pushes the snapshot onto the history.
   */
  begin: () => {
    pendingSnapshot = get().project
  },
  commit: () => {
    const snapshot = pendingSnapshot
    pendingSnapshot = null
    if (!snapshot || snapshot === get().project) return
    set((s) => ({
      past: [...s.past, snapshot].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true
    }))
  },

  update: (recipe) => {
    const before = get().project
    const after = recipe(before)
    if (after === before) return

    // Outside a transaction every change is its own history entry.
    if (pendingSnapshot === null) {
      set((s) => ({
        project: after,
        past: [...s.past, before].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true
      }))
    } else {
      set({ project: after, dirty: true })
    }
  },

  undo: () => {
    const { past, project, future } = get()
    if (past.length === 0) return
    set({
      project: past[past.length - 1],
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY_LIMIT),
      dirty: true
    })
  },

  redo: () => {
    const { future, project, past } = get()
    if (future.length === 0) return
    set({
      project: future[0],
      future: future.slice(1),
      past: [...past, project].slice(-HISTORY_LIMIT),
      dirty: true
    })
  },

  importAssets: async (paths) => {
    if (paths.length === 0) return
    const { project, notify } = get()
    const known = new Set(project.assets.map((a) => a.path))
    const fresh = paths.filter((p) => !known.has(p))
    if (fresh.length === 0) return

    try {
      const { assets, failed } = await window.forge.probe(fresh, project.settings.fps)
      if (assets.length > 0) {
        get().update((p) => ({ ...p, assets: [...p.assets, ...assets] }))
      }
      failed.forEach((f) => notify(`${f.path.split(/[\\/]/).pop()}: ${f.error}`))
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  addAssetToTimeline: (assetId) => {
    const { project, aspect } = get()
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) return

    // First track of the right kind with room, rather than a hardcoded id —
    // track ids are generated now, and v1/a1 may not exist.
    const kind = asset.kind === 'audio' ? 'audio' : 'video'
    const track =
      project.tracks.find((t) => t.kind === kind && !t.locked) ??
      project.tracks.find((t) => t.kind === kind)
    if (!track) return
    const trackId = track.id

    const existing = clipsOnTrack(project, trackId)
    const start = existing.length > 0 ? Math.max(...existing.map(clipEnd)) : 0

    const clip: Clip = {
      id: `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      assetId,
      trackId,
      start,
      duration: asset.durationFrames,
      inPoint: 0,
      volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      crop: asset.kind === 'audio' ? undefined : solveCrop(asset, aspect)
    }

    get().update((p) => ({ ...p, clips: [...p.clips, clip] }))
    get().revealClip(clip.id)
  },

  removeClip: (clipId) => {
    get().update((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== clipId) }))
    set((s) => ({ selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId }))
  },

  moveClip: (clipId, start, trackId) => {
    get().update((p) => {
      const clip = p.clips.find((c) => c.id === clipId)
      if (!clip) return p
      const targetTrack = trackId ?? clip.trackId
      const snapped = Math.max(0, Math.round(start))

      /*
       * A clip that already shares its frames with others is a LAYER, not a
       * link in a sequence, and must not be slid out of the pile.
       *
       * `findFreeSlot` walks forward to the end of everything it collides with,
       * which is right for a queue of shots and catastrophic for a stack. A
       * grid piece overlaps every other piece by design and they all end on the
       * same frame, so nudging one by a single frame threw it past the entire
       * assembled picture — in either direction — and left it playing alone
       * over black. The filmstrip stacks the same way and had the same hazard.
       *
       * Tested against where the clip currently IS rather than where it is
       * going, so an ordinary clip dragged into a crowd is still sequenced and
       * only a deliberate stack is exempt.
       */
      const stacked = overlapsOn(p, clip.trackId, clip.start, clip.duration, clipId).length > 0
      const landing = stacked
        ? snapped
        : findFreeSlot(p, targetTrack, snapped, clip.duration, clipId)

      return {
        ...p,
        clips: p.clips.map((c) =>
          c.id === clipId ? { ...c, start: landing, trackId: targetTrack } : c
        )
      }
    })
  },

  trimClipStart: (clipId, start) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === clipId ? trimStart(c, Math.round(start)) : c))
    }))
  },

  trimClipEnd: (clipId, end) => {
    get().update((p) => {
      const clip = p.clips.find((c) => c.id === clipId)
      if (!clip) return p
      const asset = p.assets.find((a) => a.id === clip.assetId)
      if (!asset) return p
      return {
        ...p,
        clips: p.clips.map((c) =>
          c.id === clipId ? trimEnd(c, Math.round(end), asset.durationFrames) : c
        )
      }
    })
  },

  splitAtPlayhead: () => {
    const { project, playhead, selectedClipId, notify } = get()
    const candidates = project.clips.filter(
      (c) => playhead > c.start && playhead < clipEnd(c) && (!selectedClipId || c.id === selectedClipId)
    )
    if (candidates.length === 0) {
      notify('Put the playhead inside a clip to split it', 'info')
      return
    }
    get().update((p) => {
      let clips = p.clips
      for (const target of candidates) {
        const halves = splitClip(target, playhead)
        if (!halves) continue
        const [left, right] = halves
        clips = clips.flatMap((c) => (c.id === target.id ? [left, { ...right, id: `${right.id}-${Date.now().toString(36)}` }] : [c]))
      }
      return { ...p, clips }
    })
  },

  setCrop: (clipId, crop) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === clipId ? { ...c, crop } : c))
    }))
  },

  /**
   * Switching aspect re-solves every video clip's crop. This is the operation the
   * whole NLE exists to make correctable — the solve is a guess, and the user
   * fixes it by dragging.
   */
  setAspect: (aspect) => {
    set({ aspect })
    const { width, height } = ASPECTS[aspect]
    get().update((p) => ({
      ...p,
      settings: { ...p.settings, width, height },
      clips: p.clips.map((c) => {
        const asset = p.assets.find((a) => a.id === c.assetId)
        if (!asset || asset.kind === 'audio') return c
        /*
         * Generated artwork is authored AT the canvas size, so auto-reframing it
         * is always wrong.
         *
         * This used to crop text, colour cards and titles like any photograph:
         * the PNG was still the old aspect, and a crop solved against the new
         * one took a sub-rectangle of it. The words ended up cut off and shoved
         * out of frame. They get redrawn at the new size instead, below.
         */
        if (c.text || c.solid || c.title) return { ...c, crop: undefined }
        return { ...c, crop: solveCrop(asset, aspect) }
      })
    }))
    void get().rebakeGenerated()
  },

  /**
   * Redraw text, colour cards and titles at the current canvas size.
   *
   * Their PNGs are canvas-sized by construction, so a change of aspect leaves
   * every one of them the wrong shape until it is drawn again.
   */
  rebakeGenerated: async () => {
    const { project } = get()
    const { width, height, fps } = project.settings
    const targets = project.clips.filter((c) => c.text || c.solid || c.title)
    if (targets.length === 0) return

    for (const clip of targets) {
      try {
        /*
         * The new path AND the new size.
         *
         * A generated card is redrawn at the current canvas size, but the asset
         * kept whatever dimensions it was probed with when it was created. So
         * after an aspect change the file was 1080x1920 and the project still
         * believed 1920x1080 — and everything measured against an asset's size
         * (the crop solver, the camera move's pre-scale) worked from the wrong
         * number for the rest of the session.
         */
        const repoint = (path: string) => (p: Project): Project => ({
          ...p,
          assets: p.assets.map((a) =>
            a.id === clip.assetId ? { ...a, path, width, height } : a
          ),
          clips: p.clips
        })

        if (clip.text) {
          const drawn = { ...clip.text, version: clip.text.version + 1 }
          const path = await bakeText(drawn, clip.id, width, height)
          /*
           * An animated caption is drawn twice, and neither one is wasted.
           *
           * The still is what `path` points at, so everything that wants ONE
           * picture of this clip — a thumbnail, a project opened by an older
           * build — still finds the settled words. The sequence is what the
           * export reads. A clip whose animation was turned off has to have its
           * old frames taken away as well, or the render would keep replaying a
           * move the editor no longer shows.
           */
          const sequence = await bakeTextSequence(
            drawn,
            clip.id,
            width,
            height,
            fps,
            clip.duration
          ).catch(() => null)
          if (!sequence) await window.forge.clearTitleFrames(clip.id).catch(() => undefined)

          get().update((p) => ({
            ...p,
            assets: p.assets.map((a) =>
              a.id === clip.assetId
                ? {
                    ...a,
                    path,
                    // Redrawn at the current canvas, so the recorded size has to
                    // move with it — see the note on `repoint` above.
                    width,
                    height,
                    frames: sequence
                      ? { pattern: sequence.pattern, count: sequence.frames }
                      : undefined
                  }
                : a
            ),
            clips: p.clips.map((c) => (c.id === clip.id ? { ...c, text: drawn } : c))
          }))
        } else if (clip.solid) {
          const drawn = { ...clip.solid, version: clip.solid.version + 1 }
          const path = await window.forge.renderSolid({ ...drawn, clipId: clip.id, width, height })
          get().update((p) => ({
            ...repoint(path)(p),
            clips: p.clips.map((c) => (c.id === clip.id ? { ...c, solid: drawn } : c))
          }))
        } else if (clip.title) {
          const drawn = { ...clip.title, version: clip.title.version + 1 }
          const path = await window.forge.renderTitle({
            template: drawn.template,
            texts: drawn.texts,
            clipId: clip.id,
            width,
            height
          })
          get().update((p) => ({
            ...repoint(path)(p),
            clips: p.clips.map((c) => (c.id === clip.id ? { ...c, title: drawn } : c))
          }))
        }
      } catch {
        // One card that will not redraw must not stop the rest of them.
      }
    }
  },

  audition: null,
  setAudition: (audition) =>
    set({ audition: audition ? { ...audition, inMs: 0, outMs: 0 } : null }),

  setAuditionRange: (inMs, outMs) =>
    set((s) => (s.audition ? { audition: { ...s.audition, inMs, outMs } } : {})),

  addAuditionToTimeline: async () => {
    const { audition, project, playhead, notify } = get()
    if (!audition) return

    try {
      const existing = project.assets.find((a) => samePath(a.path, audition.path))
      let asset = existing
      if (!asset) {
        const { assets, failed } = await window.forge.probe([audition.path], project.settings.fps)
        if (failed.length > 0 || assets.length === 0) {
          notify(failed[0]?.error ?? `Could not read ${audition.name}`)
          return
        }
        asset = assets[0]
        get().update((p) => ({ ...p, assets: [...p.assets, asset!] }))
      }

      const fps = get().project.settings.fps
      const toFrames = (ms: number): number => Math.round((ms / 1000) * fps)
      const inPoint = Math.max(0, toFrames(audition.inMs))
      const outPoint =
        audition.outMs > audition.inMs ? toFrames(audition.outMs) : asset.durationFrames
      const duration = Math.max(1, Math.min(outPoint - inPoint, asset.durationFrames - inPoint))

      const track =
        get().project.tracks.find((t) => t.kind === 'audio' && !t.locked) ??
        get().project.tracks.find((t) => t.kind === 'audio')
      if (!track) {
        notify('There is no audio track to place this on', 'info')
        return
      }

      const clipId = `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      get().update((p) => {
        /*
         * Land where the playhead is, and layer if that spot is taken.
         *
         * Placing a sound is almost always "here", not "at the end" — and two
         * pieces of music at once is a mix rather than a queue, which is what
         * the sketch meant by adding music on top of each other.
         */
        const slot = stackOverlay(p, track.id, playhead, duration)
        return {
          ...slot.project,
          clips: [
            ...slot.project.clips,
            {
              id: clipId,
              assetId: asset!.id,
              trackId: slot.trackId,
              start: slot.start,
              duration,
              inPoint,
              volume: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              color: { brightness: 0, contrast: 1, saturation: 1 }
            }
          ]
        }
      })
      get().revealClip(clipId)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  reelBuilding: false,
  reelMotion: DEFAULT_MOTION_AMOUNT,
  setReelMotion: (reelMotion) => set({ reelMotion: Math.max(0, Math.min(0.4, reelMotion)) }),
  reelTransitions: DEFAULT_REEL_TRANSITION_RATE,
  setReelTransitions: (reelTransitions) =>
    set({ reelTransitions: Math.max(0, Math.min(1, reelTransitions)) }),
  reelLyrics: false,
  setReelLyrics: (reelLyrics) => set({ reelLyrics }),
  reelParallax: false,
  setReelParallax: (reelParallax) => set({ reelParallax }),
  reelStage: null,
  reelCancelled: false,

  cancelReel: () => {
    set({ reelCancelled: true })
    // Stop whatever bake is in flight; the loop checks the flag between photos.
    for (const assetId of Object.keys(get().baking)) get().cancelBake(assetId)
  },

  clearReel: () => get().update((p) => clearGenerated(p, REEL_RULE)),

  buildReel: async () => {
    const { project, notify, reelMotion, reelTransitions, reelParallax, reelLyrics } = get()

    const musicClip = project.clips.find((clip) => {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      const asset = project.assets.find((a) => a.id === clip.assetId)
      return track?.kind === 'audio' && asset?.hasAudio
    })
    if (!musicClip) {
      notify('Add a music track first — the reel is built from its beats', 'info')
      return
    }

    const images = project.assets.filter((a) => a.kind === 'image')
    if (images.length === 0) {
      notify('Import some photos first', 'info')
      return
    }

    const videoTrack = project.tracks.find((t) => t.kind === 'video' && !t.locked)
    if (!videoTrack) {
      notify('There is no video track to build onto', 'info')
      return
    }

    const musicAsset = project.assets.find((a) => a.id === musicClip.assetId)!
    set({ reelBuilding: true, reelCancelled: false, reelStage: null })
    try {
      const fps = project.settings.fps

      /*
       * Analyse only the part of the song the clip actually keeps.
       *
       * Analysing the whole file laid a four-minute reel out of a thirty-second
       * selection — the photos were spread across audio the render would never
       * reach. The timeline already says which part is wanted; this just asks
       * the right question.
       */
      const startMs = framesToSeconds(musicClip.inPoint, fps) * 1000
      const endMs = framesToSeconds(musicClip.inPoint + musicClip.duration, fps) * 1000
      const analysis = await window.forge.analyseBeats(musicAsset.path, { startMs, endMs })
      if (get().reelCancelled) return

      /*
       * The vocal, when the user asked for it.
       *
       * Three steps and each one is worth doing separately. The song is split
       * so speech recognition hears words rather than a mix; the words come
       * back with their own timings; the openings become accents weighted by
       * how hard they land. Then they go to the planner as a third source
       * beside the grid and the structure — not instead of them.
       *
       * Failure here is not failure of the reel. A track with no words in it,
       * a model that is not installed, a transcription that comes back empty:
       * all of those mean the reel is built on beats alone, which is what it
       * did before any of this existed.
       */
      let lyrics: { ms: number; punch: number; text: string }[] = []
      if (reelLyrics) {
        try {
          set({ reelStage: 'splitting the song' })
          const stems = await window.forge.splitStems(musicAsset.path)
          if (get().reelCancelled) return

          set({ reelStage: 'reading the words' })
          const heard = await window.forge.transcribe({
            assetId: `lyrics:${musicAsset.id}`,
            path: stems.voice
          })
          if (get().reelCancelled) return

          /*
           * Transcript times are relative to the FILE, and the reel is built
           * from a window into it. Shifting them by the clip's in-point is what
           * puts a word on the frame it is sung on rather than a verse away.
           */
          const inWindow = heard.words
            .filter((w) => w.startMs >= startMs && w.startMs < endMs)
            .map((w) => ({ ...w, startMs: w.startMs - startMs, endMs: w.endMs - startMs }))

          lyrics = accentsFrom(inWindow, { syllables: true }).map((a) => ({
            ms: a.ms,
            punch: a.punch,
            text: a.text
          }))
          set({ reelStage: null })
        } catch (err) {
          console.warn('No lyrics for this track; building on beats alone', err)
          notify('Could not read the words — building on beats alone', 'info')
          lyrics = []
          set({ reelStage: null })
        }
      }

      /*
       * Bake depth before planning, so the planner knows which photos can carry
       * parallax and which get the flat move instead.
       *
       * Sequential on purpose: each bake is a few seconds of CPU, and running
       * twenty at once would take the machine away from the user for no gain.
       */
      const parallaxAssets = new Set<string>()
      if (reelParallax) {
        for (const [index, image] of images.entries()) {
          if (get().reelCancelled) break
          const existing = get().project.parallax?.[image.id]
          const bake = existing ?? (await get().bakeParallax(image.id))
          if (bake?.separated) parallaxAssets.add(image.id)
          set({ reelStage: `depth ${index + 1}/${images.length}` })
        }
        set({ reelStage: null })
      }

      // Start from a clean slate so re-running replaces rather than stacks. Read
      // it back from the store: the bakes above wrote to the project.
      const cleared = clearGenerated(get().project, REEL_RULE)
      const shots = planReel(images, analysis, {
        fps,
        motionAmount: reelMotion,
        transitionRate: reelTransitions,
        parallaxAssets,
        lyrics
      })
      if (shots.length === 0) {
        get().update(() => cleared)
        notify('No beats found in that track', 'info')
        return
      }

      // Analysis times are relative to the window; the reel sits where the music
      // sits on the timeline.
      const offset = musicClip.start
      const placedShots = shots.map((shot) => ({
        ...shot,
        startFrame: shot.startFrame + offset
      }))

      /*
       * Hold the last shot to the end of the music clip.
       *
       * The planner covers the window it was given, but the window is however
       * much audio actually decoded — which can come back shorter than the clip
       * on the timeline. A rendered 36s export ended with 4.4 seconds of music
       * over black because of exactly that. The timeline is the authority on how
       * long the reel should be, so the last shot is stretched to meet it.
       */
      const musicEnd = musicClip.start + musicClip.duration
      const tail = placedShots[placedShots.length - 1]
      if (tail && tail.startFrame + tail.durationFrames < musicEnd) {
        tail.durationFrames = musicEnd - tail.startFrame
      }

      const clips = reelClips(cleared, placedShots, videoTrack.id)

      // Transitions the plan called for, applied after placement so each clip
      // has the one before it to blend from.
      const catalogue = useCatalog.getState().transitions
      let next: Project = { ...cleared, clips: [...cleared.clips, ...clips] }
      placedShots.forEach((shot, index) => {
        if (shot.transitionTier === null || index === 0) return
        const id = pickTransition(shot.transitionTier, index, catalogue)
        if (!id) return
        // Short: a long dissolve between stills reads as a screensaver.
        const frames = Math.round(fps * (shot.transitionTier === 1 ? 0.32 : 0.22))
        // Anchored, never rippled: every one of these starts on a beat, a drop
        // or a sung word, and `addTransition` would drag them all off it.
        next = anchorTransitionOn(next, clips[index].id, id, frames)
      })

      get().update(() => next)
      const withTransitions = placedShots.filter((s) => s.transitionTier !== null).length
      const withDepth = placedShots.filter((s) => s.motion?.kind === 'parallax').length

      const seconds = ((endMs - startMs) / 1000).toFixed(1)
      // Say whether depth actually happened. Without this the only way to know
      // was to squint at the preview and guess.
      const depthNote = reelParallax
        ? withDepth > 0
          ? `, ${withDepth} with depth`
          : ', no photo had enough depth to separate'
        : ''
      notify(
        `Built ${clips.length} shots over ${seconds}s — ${withTransitions} with transitions${depthNote}, ${analysis.bpm} BPM`,
        'info'
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      set({ reelBuilding: false, reelStage: null, reelCancelled: false })
    }
  },

  onePhotoCaption: '',
  setOnePhotoCaption: (onePhotoCaption) => set({ onePhotoCaption }),

  clearOnePhotoReel: () =>
    get().update((p) => clearGenerated(clearGenerated(p, ONE_PHOTO_RULE), ONE_PHOTO_CAPTION_RULE)),

  buildOnePhotoReel: async (assetId) => {
    const { project, notify, reelMotion, reelTransitions, onePhotoCaption } = get()

    const musicClip = project.clips.find((clip) => {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      const asset = project.assets.find((a) => a.id === clip.assetId)
      return track?.kind === 'audio' && asset?.hasAudio
    })
    if (!musicClip) {
      notify('Add a music track first — the reel is built from its beats', 'info')
      return
    }

    // Whichever photo they meant: the one they asked for, the one selected, or
    // the only one there is.
    const images = project.assets.filter((a) => a.kind === 'image')
    const selectedAsset = project.clips.find((c) => c.id === get().selectedClipId)?.assetId
    const photo =
      images.find((a) => a.id === assetId) ??
      images.find((a) => a.id === selectedAsset) ??
      images[0]
    if (!photo) {
      notify('Import a photo first', 'info')
      return
    }
    if (!photo.width || !photo.height) {
      notify('That photo has no size on it — try re-importing it', 'info')
      return
    }

    const videoTrack = project.tracks.find((t) => t.kind === 'video' && !t.locked)
    if (!videoTrack) {
      notify('There is no video track to build onto', 'info')
      return
    }

    const musicAsset = project.assets.find((a) => a.id === musicClip.assetId)!
    set({ reelBuilding: true, reelCancelled: false, reelStage: null })
    try {
      const fps = project.settings.fps
      const startMs = framesToSeconds(musicClip.inPoint, fps) * 1000
      const endMs = framesToSeconds(musicClip.inPoint + musicClip.duration, fps) * 1000
      const analysis = await window.forge.analyseBeats(musicAsset.path, { startMs, endMs })

      /*
       * The bake is not optional here the way it is for a multi-photo reel.
       *
       * It carries the subject box, and without that every crop is a guess: a
       * close-up framed on the middle of the picture lands on the subject's
       * waist. Depth planes are the second prize.
       */
      set({ reelStage: 'finding the subject' })
      const bake = get().project.parallax?.[photo.id] ?? (await get().bakeParallax(photo.id))
      set({ reelStage: null })
      if (get().reelCancelled) return

      const box = bake?.subjectBox
      const subject = box
        ? {
            x: box.x * photo.width,
            y: box.y * photo.height,
            width: box.width * photo.width,
            height: box.height * photo.height
          }
        : null

      const cleared = clearGenerated(
        clearGenerated(get().project, ONE_PHOTO_RULE),
        ONE_PHOTO_CAPTION_RULE
      )
      const { shots, cards, ladder } = planOnePhotoReel({
        analysis,
        fps,
        source: { width: photo.width, height: photo.height },
        aspectRatio: project.settings.width / project.settings.height,
        outputHeight: project.settings.height,
        subject,
        caption: onePhotoCaption,
        hasDepth: bake?.separated === true,
        motionAmount: reelMotion,
        transitionRate: reelTransitions
      })
      if (shots.length === 0) {
        get().update(() => cleared)
        notify('No beats found in that track', 'info')
        return
      }

      // Analysis times are relative to the window; the reel sits where the music
      // sits on the timeline.
      const offset = musicClip.start
      const placed = shots.map((shot) => ({ ...shot, startFrame: shot.startFrame + offset }))

      // The timeline is the authority on how long the reel runs — decoded audio
      // can come back shorter than the clip and leave the tail over black.
      const musicEnd = musicClip.start + musicClip.duration
      const tail = placed[placed.length - 1]
      if (tail && tail.startFrame + tail.durationFrames < musicEnd) {
        tail.durationFrames = musicEnd - tail.startFrame
      }

      const clips = onePhotoClips(cleared, placed, videoTrack.id, photo.id)
      const catalogue = useCatalog.getState().transitions
      let next: Project = { ...cleared, clips: [...cleared.clips, ...clips] }
      placed.forEach((shot, index) => {
        if (shot.transitionTier === null || index === 0) return
        const id = pickTransition(shot.transitionTier, index, catalogue)
        if (!id) return
        const frames = Math.round(fps * (shot.transitionTier === 1 ? 0.32 : 0.22))
        // Anchored, never rippled: every one of these starts on a beat, a drop
        // or a sung word, and `addTransition` would drag them all off it.
        next = anchorTransitionOn(next, clips[index].id, id, frames)
      })
      get().update(() => next)

      // Caption cards go on a layer above the picture, so they survive the cuts
      // underneath them rather than being one of them.
      let written = 0
      if (cards.length > 0) {
        const overlay = overlayTrackFor(get().project) ?? videoTrack
        for (const card of cards) {
          if (get().reelCancelled) break
          const made = await get().addTextClip(overlay.id, card.startFrame + offset)
          if (!made) continue
          written++
          get().update((p) => ({
            ...p,
            clips: p.clips.map((c) =>
              c.id === made
                ? {
                    ...c,
                    duration: card.durationFrames,
                    generatedBy: { rule: ONE_PHOTO_CAPTION_RULE, reason: card.reason }
                  }
                : c
            )
          }))
          await get().setText(made, { content: card.text })
        }
      }

      const shotWord = `${clips.length} shots from one photo`
      const framings = new Set(placed.map((s) => s.framing)).size
      const depthNote = placed.some((s) => s.motion?.kind === 'parallax') ? ', depth on the wides' : ''
      const cardNote = written > 0 ? `, ${written} caption cards on the bar` : ''
      notify(
        `${shotWord} — ${framings} framings${depthNote}${cardNote}, ${analysis.bpm} BPM`,
        'info'
      )
      if (!box) {
        notify('No subject found in that photo — framings are centred guesses', 'info')
      }
      if (ladder.length < 3) {
        notify('That photo has little room to punch in — the camera carries more of it', 'info')
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      set({ reelBuilding: false, reelStage: null, reelCancelled: false })
    }
  },

  propsEnabled: false,
  propsPerMinute: DEFAULT_TRIGGER_OPTIONS.perMinute,
  setPropsEnabled: (propsEnabled) => set({ propsEnabled }),
  setPropsPerMinute: (propsPerMinute) => set({ propsPerMinute: Math.max(1, Math.min(30, propsPerMinute)) }),

  clearPropRule: () => get().update((p) => clearGenerated(p, PROP_RULE)),

  applyPropRule: async () => {
    const { project, propsPerMinute, notify } = get()
    if (Object.keys(project.transcripts).length === 0) {
      notify('Transcribe something first — props fire on spoken words', 'info')
      return
    }

    const track = overlayTrackFor(project)
    if (!track) {
      notify('There is no video track to place props on', 'info')
      return
    }

    try {
      const { catalog } = await window.forge.assetCatalog()
      const props = entriesOfKind(catalog, 'prop').map((entry) => ({
        assetId: entry.id,
        file: entry.file,
        name: entry.name,
        tags: tagsForProp(entry.name)
      }))
      if (props.length === 0) {
        notify('No props found in the asset library', 'info')
        return
      }

      const fps = project.settings.fps
      // Start from a clean slate so re-running replaces rather than stacks.
      const cleared = clearGenerated(project, PROP_RULE)
      const planned = planPropClips(
        cleared,
        props,
        { perMinute: propsPerMinute, cooldownMs: DEFAULT_TRIGGER_OPTIONS.cooldownMs, fps },
        Math.round(fps * 1.5)
      )

      if (planned.length === 0) {
        get().update(() => cleared)
        notify('No keywords matched — nothing to place', 'info')
        return
      }

      // Import each distinct prop once, however many times it fires.
      const assetByFile = new Map<string, string>()
      for (const plan of planned) {
        if (assetByFile.has(plan.file)) continue
        const existing = cleared.assets.find((a) => a.name === plan.name)
        if (existing) {
          assetByFile.set(plan.file, existing.id)
          continue
        }
        const asset = await window.forge.placeAsset(plan.file, fps)
        assetByFile.set(plan.file, asset.id)
        cleared.assets.push({ ...asset, name: plan.name })
      }

      /*
       * Props stack when two fire at once, rather than landing on top of
       * each other.
       *
       * This consulted nothing at all — every prop went onto the single overlay
       * track at the frame its keyword hit, so two keywords close together put
       * two clips in the same place on the same track. The later one simply
       * covered the earlier one, and only one of the pair was ever visible.
       *
       * The working project is threaded through the fold so each prop sees the
       * ones already placed, which is the whole reason this cannot be a `map`.
       */
      let working: Project = { ...cleared, assets: [...cleared.assets] }
      planned.forEach((plan, index) => {
        const slot = stackOverlay(working, track.id, plan.startFrame, plan.durationFrames)
        working = {
          ...slot.project,
          clips: [
            ...slot.project.clips,
            makeGeneratedClip({
              id: `auto-${PROP_RULE}-${index}-${Date.now().toString(36)}`,
              assetId: assetByFile.get(plan.file)!,
              trackId: slot.trackId,
              startFrame: slot.start,
              durationFrames: plan.durationFrames,
              rule: PROP_RULE,
              reason: plan.reason
            })
          ]
        }
      })

      const clips = working.clips.filter((c) => c.generatedBy?.rule === PROP_RULE)
      get().update(() => working)
      notify(`Placed ${clips.length} prop${clips.length === 1 ? '' : 's'}`, 'info')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  addTextClip: async (trackId, startFrame) => {
    const { project, notify } = get()
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked || track.kind !== 'video') {
      notify('Pick a video track for text', 'info')
      return null
    }

    const clipId = `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const spec: TextSpec = { ...DEFAULT_TEXT, version: 1 }
    const { width, height, fps } = project.settings
    const duration = Math.round(fps * 3)
    const assetId = `text-asset-${clipId}`

    /*
     * The clip appears immediately.
     *
     * Adding text used to mean waiting through a full-canvas PNG encode, an IPC
     * transfer, a disk write and then an ffprobe PROCESS SPAWN to ask the file
     * how big it was — before a single pixel showed. Every one of those answers
     * was already known here: a text card is exactly the size of the canvas.
     * So the asset is written out directly and the clip is on the timeline in
     * the same tick as the click.
     *
     * The PNG is still written, in the background and with nobody waiting on
     * it, so the file is warm long before an export asks for it — and the
     * export rebakes every generated card anyway, so a missed write cannot
     * produce a wrong frame.
     */
    get().update((p) => {
      // Text on text is a layer, not a sequence — so this climbs a track rather
      // than sliding the new line later in time.
      const slot = stackOverlay(p, trackId, startFrame, duration)
      return {
        ...slot.project,
        assets: [
          ...slot.project.assets,
          {
            id: assetId,
            // Filled in when the background bake lands. The preview draws the
            // type live and never reads this.
            path: '',
            name: spec.content,
            kind: 'image',
            durationFrames: Math.max(duration, Math.round(fps * 10)),
            width,
            height,
            fps: null,
            hasVideo: true,
            hasAudio: false,
            size: 0
          }
        ],
        clips: [
          ...slot.project.clips,
          {
            id: clipId,
            assetId,
            trackId: slot.trackId,
            start: slot.start,
            duration,
            inPoint: 0,
            volume: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
            color: { brightness: 0, contrast: 1, saturation: 1 },
            text: spec
          }
        ]
      }
    })
    get().revealClip(clipId)

    bakeText(spec, clipId, width, height)
      .then((path) => {
        get().update((p) => ({
          ...p,
          assets: p.assets.map((a) => (a.id === assetId ? { ...a, path } : a))
        }))
      })
      .catch((err) => notify(err instanceof Error ? err.message : String(err)))

    return clipId
  },

  setText: async (clipId, patch) => {
    const clip = get().project.clips.find((c) => c.id === clipId)
    if (!clip?.text) return

    /*
     * Typing is a store write and nothing else.
     *
     * This used to schedule a PNG bake behind every burst of typing: a
     * full-canvas encode, an IPC transfer, a disk write and a re-decode, all so
     * the preview could load a file to show letters it already knew. The
     * preview now draws the type itself, from this very spec, and the file is
     * written once on the way to an export — where it is the only place it has
     * ever actually been needed.
     *
     * `version` names the bytes on disk and is deliberately untouched here.
     * Nothing has been written, so claiming otherwise would send the preview to
     * re-fetch a file holding the previous picture and never ask again.
     *
     * The burst is still one undo entry: a transaction opens on the first
     * keystroke and closes when the typing stops.
     */
    const pending = pendingText.get(clipId)
    if (!pending) get().begin()
    else clearTimeout(pending.timer)

    const spec: TextSpec = { ...clip.text, ...patch }
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === clipId ? { ...c, text: spec } : c))
    }))

    const timer = setTimeout(() => {
      pendingText.delete(clipId)
      get().commit()
    }, TEXT_COALESCE_MS)

    pendingText.set(clipId, { spec, timer })
  },

  /**
   * An adjustment layer.
   *
   * Backed by a transparent card so it is an ordinary clip — draggable,
   * trimmable, selectable — rather than a special case the timeline has to know
   * about. Nothing of the card is ever drawn; `adjustment` makes the renderer
   * grade the stream underneath instead of compositing it.
   */
  addAdjustmentLayer: async (trackId, startFrame) => {
    const { project, notify } = get()
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked || track.kind !== 'video') {
      notify('Pick a video track for an adjustment layer', 'info')
      return null
    }

    const clipId = `adjust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    try {
      const path = await window.forge.renderSolid({
        color: '#000000',
        opacity: 0,
        clipId,
        width: 16,
        height: 16
      })
      const asset = await window.forge.placeAsset(path, project.settings.fps)
      const duration = Math.round(project.settings.fps * 3)

      get().update((p) => {
        const slot = stackOverlay(p, trackId, startFrame, duration)
        return {
          ...slot.project,
          assets: [...slot.project.assets, { ...asset, name: 'Adjustment' }],
          clips: [
            ...slot.project.clips,
            {
              id: clipId,
              assetId: asset.id,
              trackId: slot.trackId,
              start: slot.start,
              duration,
              inPoint: 0,
              volume: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              color: { ...DEFAULT_COLOR },
              adjustment: true
            }
          ]
        }
      })
      get().revealClip(clipId)
      notify('Grading everything on the tracks below it', 'info')
      return clipId
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
      return null
    }
  },

  addSolidClip: async (trackId, startFrame) => {
    const { project, notify } = get()
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked || track.kind !== 'video') {
      notify('Pick a video track for a colour card', 'info')
      return null
    }

    const clipId = `solid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const spec: SolidSpec = { color: '#000000', opacity: 1, version: 1 }
    try {
      const path = await window.forge.renderSolid({
        ...spec,
        clipId,
        width: project.settings.width,
        height: project.settings.height
      })
      const asset = await window.forge.placeAsset(path, project.settings.fps)
      const duration = Math.round(project.settings.fps * 3)

      get().update((p) => {
        const slot = stackOverlay(p, trackId, startFrame, duration)
        return {
          ...slot.project,
          assets: [...slot.project.assets, { ...asset, name: 'Colour' }],
          clips: [
            ...slot.project.clips,
            {
              id: clipId,
              assetId: asset.id,
              trackId: slot.trackId,
              start: slot.start,
              duration,
              inPoint: 0,
              volume: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              color: { brightness: 0, contrast: 1, saturation: 1 },
              solid: spec
            }
          ]
        }
      })
      get().revealClip(clipId)
      return clipId
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
      return null
    }
  },

  setSolid: async (clipId, patch) => {
    const { project, notify } = get()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip?.solid) return

    const spec: SolidSpec = { ...clip.solid, ...patch, version: clip.solid.version + 1 }
    try {
      await window.forge.renderSolid({
        ...spec,
        clipId,
        width: project.settings.width,
        height: project.settings.height
      })
      get().update((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === clipId ? { ...c, solid: spec } : c))
      }))
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  placeTitle: async (template, name, trackId, startFrame) => {
    const { project, notify } = get()
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked) return

    try {
      const slots = await window.forge.titleSlots(template)
      const texts = slots.map((slot) => slot.placeholder)
      const clipId = `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

      const path = await window.forge.renderTitle({
        template,
        texts,
        clipId,
        width: project.settings.width,
        height: project.settings.height
      })

      const asset = await window.forge.placeAsset(path, project.settings.fps)
      const fps = project.settings.fps
      const duration = Math.round(fps * 3)

      get().update((p) => {
        const slot = stackOverlay(p, trackId, startFrame, duration)
        return {
          ...slot.project,
          assets: [...slot.project.assets, { ...asset, name }],
          clips: [
            ...slot.project.clips,
            {
              id: clipId,
              assetId: asset.id,
              trackId: slot.trackId,
              start: slot.start,
              duration,
              inPoint: 0,
              volume: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              color: { brightness: 0, contrast: 1, saturation: 1 },
              title: { template, texts, version: 1 }
            }
          ]
        }
      })
      get().revealClip(clipId)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  setTitleText: async (clipId, index, text) => {
    const { project, notify } = get()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip?.title) return

    const texts = [...clip.title.texts]
    texts[index] = text

    try {
      await window.forge.renderTitle({
        template: clip.title.template,
        texts,
        clipId,
        width: project.settings.width,
        height: project.settings.height
      })
      // The file is overwritten in place, so the path is unchanged — the version
      // is what tells the preview to reload it.
      get().update((p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === clipId && c.title
            ? { ...c, title: { ...c.title, texts, version: c.title.version + 1 } }
            : c
        )
      }))
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  placeLibraryAsset: async (file, name, trackId, startFrame) => {
    const { project, notify } = get()
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked) return

    try {
      // Reuse an already-imported copy rather than re-rasterising and
      // re-probing the same sticker every time it is dropped.
      const existing = project.assets.find((a) => a.name === name)
      let asset = existing
      if (!asset) {
        asset = await window.forge.placeAsset(file, project.settings.fps)
        get().update((p) => ({ ...p, assets: [...p.assets, asset!] }))
      }

      const fps = get().project.settings.fps
      // A still has no natural length; three seconds reads as deliberate.
      const duration =
        asset.kind === 'image' ? Math.round(fps * 3) : asset.durationFrames

      const clipId = `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      get().update((p) => {
        /*
         * A sticker or a prop is dropped ONTO something.
         *
         * Sliding it later would put the sticker on a different shot from the
         * one it was aimed at — the moment is the whole point of the gesture.
         */
        const slot = stackOverlay(p, trackId, startFrame, duration)
        return {
          ...slot.project,
          clips: [
            ...slot.project.clips,
            {
              id: clipId,
              assetId: asset!.id,
              trackId: slot.trackId,
              start: slot.start,
              duration,
              inPoint: 0,
              volume: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              color: { brightness: 0, contrast: 1, saturation: 1 }
            }
          ]
        }
      })
      // Stickers and props are adjusted the moment they land, so the thing
      // just dropped has to be the thing on screen.
      get().revealClip(clipId)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  setKeyframe: (clipId, property, frame, value, ease) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c
        const at = Math.max(0, Math.min(c.duration, Math.round(frame)))
        const existing = c.keyframes?.[property] ?? []
        // normaliseKeys keeps the later of two keys at one frame, so appending
        // is how a key is replaced.
        const next = normaliseKeys(
          [...existing, { frame: at, value, ...(ease ? { ease } : keepEase(existing, at)) }],
          c.duration
        )
        return { ...c, keyframes: { ...c.keyframes, [property]: next } }
      })
    }))
  },

  setKeyframes: (clipId, property, keys) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c
        const next = normaliseKeys(keys, c.duration)
        const tracks = { ...c.keyframes, [property]: next }
        if (next.length === 0) delete tracks[property]
        return { ...c, keyframes: Object.keys(tracks).length > 0 ? tracks : undefined }
      })
    }))
  },

  removeKeyframe: (clipId, property, frame) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c
        const kept = (c.keyframes?.[property] ?? []).filter((k) => k.frame !== Math.round(frame))
        const tracks = { ...c.keyframes, [property]: kept }
        if (kept.length === 0) delete tracks[property]
        return { ...c, keyframes: Object.keys(tracks).length > 0 ? tracks : undefined }
      })
    }))
  },

  clearKeyframes: (clipId, property) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c
        const tracks = { ...c.keyframes }
        delete tracks[property]
        return { ...c, keyframes: Object.keys(tracks).length > 0 ? tracks : undefined }
      })
    }))
  },

  /**
   * Text as a window onto the picture beneath it.
   *
   * The clip stays exactly where it is and keeps being editable — retype the
   * word and the fill follows it — but stops being drawn in its own right. The
   * picture underneath takes its shape instead.
   */
  fillWithClipBelow: (clipId) => {
    const { project, notify } = get()
    const shape = project.clips.find((c) => c.id === clipId)
    if (!shape) return

    const under = transitionBase(project, shape)
    if (!under || under.kind !== 'layer') {
      notify('Put this on a track above the picture you want showing through', 'info')
      return
    }

    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id === shape.id) return { ...c, matteOnly: true }
        if (c.id === under.clip.id) return { ...c, matte: { clipId: shape.id } }
        return c
      })
    }))
    notify('The picture below is showing through this shape', 'info')
  },

  releaseMatte: (clipId) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id === clipId) {
          const { matteOnly: _drop, ...rest } = c
          return rest
        }
        if (c.matte?.clipId === clipId) {
          const { matte: _also, ...rest } = c
          return rest
        }
        return c
      })
    }))
  },

  setTransform: (clipId, patch) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === clipId ? { ...c, transform: { ...c.transform, ...patch } } : c
      )
    }))
  },

  setColor: (clipId, patch) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === clipId
          ? { ...c, color: { ...DEFAULT_COLOR, ...c.color, ...patch } }
          : c
      )
    }))
  },

  /**
   * Lay this clip and the one under it out as a split screen.
   *
   * Both clips stay exactly where they are on the timeline and stay entirely
   * editable — all that changes is each one's box. Nothing is hidden and there
   * is no split-screen mode to leave: drag a panel, resize it, or set its
   * transform back to full frame and the split is gone.
   */
  splitWithClipBelow: (clipId, layout) => {
    const { project, notify } = get()
    const top = project.clips.find((c) => c.id === clipId)
    if (!top) return

    const under = transitionBase(project, top)
    if (!under || under.kind !== 'layer') {
      notify('Put this on a track above the clip you want beside it', 'info')
      return
    }

    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id === top.id) {
          return { ...c, transform: { ...c.transform, ...splitTransform(layout, 0) } }
        }
        if (c.id === under.clip.id) {
          return { ...c, transform: { ...c.transform, ...splitTransform(layout, 1) } }
        }
        return c
      })
    }))
    notify(
      layout === 'rows' ? 'Split — this one on top' : 'Split — this one on the left',
      'info'
    )
  },

  /**
   * Shrink this clip into a corner, over whatever is underneath.
   *
   * The reaction layout. `shape` picks the box and, for a circle or a rounded
   * frame, the mask that trims it — a mask is sized against the clip's own
   * stream rather than the canvas, so it travels with the inset when the inset
   * is moved.
   */
  makePip: (clipId, options) => {
    const { project, notify } = get()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip) return

    const canvas = ASPECTS[get().aspect]
    const settings = { ...DEFAULT_PIP, ...options }
    const transform = pipTransform({ ...settings, canvas })

    /*
     * The frame treatment, as a mask over the whole box.
     *
     * Half-extents of 0.5 cover the stream exactly, so the only thing the shape
     * does is round or oval the edges. A hard-cornered inset gets no mask at
     * all rather than a square one — a filter that changes nothing is a filter
     * paid for on every frame.
     */
    const mask: Mask | undefined =
      settings.shape === 'circle'
        ? {
            mode: 'reveal',
            blur: 0,
            shape: {
              kind: 'ellipse',
              x: 0.5,
              y: 0.5,
              width: 0.5,
              height: 0.5,
              rotation: 0,
              feather: 0.02,
              invert: false
            }
          }
        : settings.radius && settings.radius > 0
          ? {
              mode: 'reveal',
              blur: 0,
              shape: {
                kind: 'rectangle',
                x: 0.5,
                y: 0.5,
                width: 0.5,
                height: 0.5,
                rotation: 0,
                radius: settings.radius,
                feather: 0.01,
                invert: false
              }
            }
          : undefined

    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === clipId ? { ...c, transform: { ...c.transform, ...transform }, mask } : c
      )
    }))
    notify('Picture in picture — drag it anywhere on the preview', 'info')
  },

  setMask: (clipId, mask) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === clipId ? { ...c, mask } : c))
    }))
  },

  setMaskShape: (clipId, patch) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) =>
        // A shape patch on a clip with no mask yet would otherwise write a
        // half-built mask with no mode on it.
        c.id === clipId && c.mask
          ? { ...c, mask: { ...c.mask, shape: { ...c.mask.shape, ...patch } } }
          : c
      )
    }))
  },

  chooseLut: async (clipId) => {
    const { notify } = get()
    try {
      const file = await window.forge.pickLut()
      if (!file) return
      const name = file.split(/[\\/]/).pop()?.replace(/\.cube$/i, '') ?? 'LUT'
      /*
       * 0.8 rather than 1.
       *
       * A look at full strength is the most common way a grade goes wrong, and
       * every tool that ships an intensity control defaults below the top of it.
       */
      get().setColor(clipId, { lut: { file, name, intensity: 0.8 } })
      notify(`${name} applied`, 'info')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  },

  filmstripPanels: DEFAULT_VISIBLE,
  setFilmstripPanels: (n) => set({ filmstripPanels: Math.max(2, Math.min(8, Math.round(n))) }),
  filmstripSeconds: 4,
  setFilmstripSeconds: (v) => set({ filmstripSeconds: Math.max(1, Math.min(15, v)) }),

  buildFilmstrip: () => {
    const { project, playhead, notify, filmstripPanels, filmstripSeconds } = get()
    const images = project.assets.filter((a) => a.kind === 'image')
    if (images.length === 0) {
      notify('Import some photos first', 'info')
      return
    }
    const track = project.tracks.find((t) => t.kind === 'video' && !t.locked)
    if (!track) {
      notify('There is no video track to build onto', 'info')
      return
    }

    const duration = secondsToFrames(filmstripSeconds, project.settings.fps)
    const cleared = clearGenerated(project, FILMSTRIP_RULE)
    const panels = planFilmstrip(images, duration, { visible: filmstripPanels })
    const clips = filmstripClips(panels, track.id, playhead, duration)
    get().update(() => ({ ...cleared, clips: [...cleared.clips, ...clips] }))
    notify(`${clips.length} panels sliding across ${filmstripSeconds}s`, 'info')
  },

  clearFilmstrip: () => get().update((p) => clearGenerated(p, FILMSTRIP_RULE)),

  /* ------------------------------------------------------- the grid split */

  gridPieces: 4,
  setGridPieces: (n) => set({ gridPieces: Math.max(2, Math.min(36, Math.round(n))) }),
  gridShape: 'square',
  setGridShape: (gridShape) => set({ gridShape }),
  gridOrder: 'random',
  setGridOrder: (gridOrder) => set({ gridOrder }),
  gridArrival: 'pop',
  setGridArrival: (gridArrival) => set({ gridArrival }),
  gridGap: 0,
  setGridGap: (gap) => set({ gridGap: Math.max(0, Math.min(0.3, gap)) }),
  gridTilt: 0,
  setGridTilt: (tilt) => set({ gridTilt: Math.max(0, Math.min(25, tilt)) }),
  // An eighth note, which is what the reference templates actually move at.
  // A whole beat looks right on paper and plays at half the speed.
  gridBeatsPerCell: 0.5,
  setGridBeatsPerCell: (beats) =>
    set({ gridBeatsPerCell: Math.max(0.25, Math.min(8, beats)) }),
  gridBuilding: false,

  clearGrid: () => get().update((p) => clearGenerated(p, GRID_RULE)),

  buildGrid: async (assetId) => {
    const {
      project,
      notify,
      playhead,
      gridPieces,
      gridShape,
      gridOrder,
      gridArrival,
      gridGap,
      gridTilt,
      gridBeatsPerCell
    } = get()

    // A second press while the first build is still analysing would clear the
    // first one's output halfway through writing it. The disabled button is not
    // enough on its own — the action is reachable from elsewhere.
    if (get().gridBuilding) return

    // Whichever photo they meant: the one asked for, the one selected, or the
    // only one there is. Same rule as the one-photo reel.
    const images = project.assets.filter((a) => a.kind === 'image')
    const selected = project.clips.find((c) => c.id === get().selectedClipId)?.assetId
    const photo =
      images.find((a) => a.id === assetId) ?? images.find((a) => a.id === selected) ?? images[0]
    if (!photo) {
      notify('Import a photo first — the grid is cut out of one picture', 'info')
      return
    }
    if (!photo.width || !photo.height) {
      notify('That photo has no size on it — try re-importing it', 'info')
      return
    }

    /*
     * The topmost lane, not the footage lane.
     *
     * The grid's pieces all overlap in time by design and are anchored where
     * the music starts — which is exactly where the beat-synced reel wants to
     * put its first shot. Sharing a lane, the reel's `findFreeSlot` walked past
     * the whole grid and displaced every shot several seconds late, off the
     * music it had just been cut to. On a single-track project this resolves to
     * the same lane and nothing changes.
     */
    const track =
      overlayTrackFor(project) ?? project.tracks.find((t) => t.kind === 'video' && !t.locked)
    if (!track) {
      notify('There is no video track to build onto', 'info')
      return
    }

    const { width, height, fps } = project.settings
    const musicClip = project.clips.find((clip) => {
      const lane = project.tracks.find((t) => t.id === clip.trackId)
      const asset = project.assets.find((a) => a.id === clip.assetId)
      return lane?.kind === 'audio' && asset?.hasAudio
    })

    set({ gridBuilding: true })
    try {
      /*
       * The music, when there is some.
       *
       * Unlike the reel, this rule does not require it. A grid on an even
       * cadence is still the effect — the beats make it land, they are not what
       * makes it exist — and refusing to build without a song would put a
       * feature behind a step nobody has taken yet.
       */
      let analysis = null
      let startFrame = playhead
      if (musicClip) {
        const musicAsset = project.assets.find((a) => a.id === musicClip.assetId)
        if (musicAsset) {
          const startMs = framesToSeconds(musicClip.inPoint, fps) * 1000
          const endMs = framesToSeconds(musicClip.inPoint + musicClip.duration, fps) * 1000
          analysis = await window.forge.analyseBeats(musicAsset.path, { startMs, endMs })
          // Beat times are relative to the analysed window, so the grid starts
          // where the music does rather than where the playhead happens to be.
          startFrame = musicClip.start
        }
      }

      const { rows, cols } = gridFor(gridPieces, width / height)
      const pieces = planGridSplit({
        fps,
        source: { width: photo.width, height: photo.height },
        canvas: { width, height },
        spec: {
          ...DEFAULT_GRID,
          rows,
          cols,
          shape: gridShape,
          gap: gridGap,
          tilt: gridTilt
        },
        order: gridOrder,
        analysis,
        beatsPerCell: gridBeatsPerCell,
        startFrame
      })
      if (pieces.length === 0) {
        notify('Nothing to build — the grid came out empty', 'info')
        return
      }

      /*
       * The photograph and the lane are re-checked after the await.
       *
       * Analysing a track goes to the Python sidecar and can take seconds, and
       * nothing stops the user opening a different project while it runs. The
       * clear below already re-reads the current project — but the clips were
       * still being stamped with the asset id captured before the wait, so a
       * project swap wrote twenty clips pointing at an asset that project has
       * never heard of. It would not have failed loudly: saving is silent when
       * the file already has a path, and re-opening a project whose clips name
       * a missing asset throws rather than offering to relink.
       */
      const current = get().project
      if (
        !current.assets.some((a) => a.id === photo.id) ||
        !current.tracks.some((t) => t.id === track.id)
      ) {
        notify('The project changed while the music was being analysed — build it again', 'info')
        return
      }

      const cleared = clearGenerated(current, GRID_RULE)
      const clips = gridClips(pieces, track.id, photo.id, fps, gridArrival)
      get().update(() => ({ ...cleared, clips: [...cleared.clips, ...clips] }))
      notify(
        analysis
          ? `${clips.length} pieces, landing on the beat`
          : `${clips.length} pieces at the playhead`,
        'info'
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      set({ gridBuilding: false })
    }
  },

  /* ------------------------------------------------------------- strips */

  stripLayout: 'vertical',
  setStripLayout: (stripLayout) => set({ stripLayout }),
  stripCount: DEFAULT_STRIP_COUNT,
  setStripCount: (n) => set({ stripCount: Math.max(2, Math.min(12, Math.round(n))) }),
  stripPerHit: 2,
  setStripPerHit: (n) => set({ stripPerHit: Math.max(1, Math.min(6, Math.round(n))) }),
  stripLook: 'flash',
  setStripLook: (stripLook) => set({ stripLook }),
  stripBeatsPerHit: DEFAULT_BEATS_PER_HIT,
  setStripBeatsPerHit: (beats) =>
    set({ stripBeatsPerHit: Math.max(0.25, Math.min(4, beats)) }),
  stripBursts: DEFAULT_BURST_RATE,
  setStripBursts: (rate) => set({ stripBursts: Math.max(0, Math.min(1, rate)) }),
  stripsBuilding: false,

  clearStrips: () => get().update((p) => clearGenerated(p, STRIP_RULE)),

  buildStrips: async () => {
    const {
      project,
      notify,
      playhead,
      stripLayout,
      stripCount,
      stripPerHit,
      stripLook,
      stripBeatsPerHit,
      stripBursts
    } = get()
    if (get().stripsBuilding) return

    /*
     * The shot the strips interrupt.
     *
     * Whatever is under the playhead, or failing that the first picture on the
     * timeline. The strips take that clip's OWN asset, so what flashes is a
     * treated copy of the shot rather than something unrelated cutting in — the
     * whole effect depends on the viewer recognising it as the same picture.
     */
    const videoTracks = project.tracks.filter((t) => t.kind === 'video')
    const candidates = project.clips.filter(
      (c) =>
        videoTracks.some((t) => t.id === c.trackId) &&
        !c.generatedBy &&
        !c.text &&
        !c.solid &&
        !c.adjustment
    )
    const base =
      candidates.find((c) => playhead >= c.start && playhead < c.start + c.duration) ??
      candidates.sort((a, b) => b.duration - a.duration)[0]
    if (!base) {
      notify('Put a shot on the timeline first — the strips flash over it', 'info')
      return
    }

    const asset = project.assets.find((a) => a.id === base.assetId)
    if (!asset?.width || !asset.height) {
      notify('That clip has no size on it — try re-importing the media', 'info')
      return
    }

    const overlay = overlayTrackFor(project)
    if (!overlay || overlay.id === base.trackId) {
      notify('Add a video track above the shot — the strips need a layer of their own', 'info')
      return
    }

    /*
     * The strips are cut out of what the shot is SHOWING, not out of the whole
     * file. A clip that has been reframed shows a rectangle of its source, and
     * strips measured against the file would be slices of pixels nobody can see.
     */
    const region = base.crop ?? { x: 0, y: 0, width: asset.width, height: asset.height }
    const { width, height, fps } = project.settings

    const musicClip = project.clips.find((clip) => {
      const lane = project.tracks.find((t) => t.id === clip.trackId)
      const track = project.assets.find((a) => a.id === clip.assetId)
      return lane?.kind === 'audio' && track?.hasAudio
    })

    set({ stripsBuilding: true })
    try {
      let analysis = null
      if (musicClip) {
        const musicAsset = project.assets.find((a) => a.id === musicClip.assetId)
        if (musicAsset) {
          const startMs = framesToSeconds(musicClip.inPoint, fps) * 1000
          const endMs = framesToSeconds(musicClip.inPoint + musicClip.duration, fps) * 1000
          analysis = await window.forge.analyseBeats(musicAsset.path, { startMs, endMs })
        }
      }

      const current = get().project
      if (
        !current.clips.some((c) => c.id === base.id) ||
        !current.tracks.some((t) => t.id === overlay.id)
      ) {
        notify('The timeline changed while the music was being analysed — build it again', 'info')
        return
      }

      /*
       * Beat times are measured from the music's own start, so the run is
       * anchored there and clipped to the shot: flashes over black after the
       * picture has ended are not an effect, they are a bug with a rhythm.
       */
      const anchor = musicClip ? musicClip.start : base.start
      const options = {
        fps,
        source: { width: region.width, height: region.height },
        canvas: { width, height },
        layout: stripLayout,
        count: stripCount,
        perHit: stripPerHit,
        look: stripLook,
        beatsPerHit: stripBeatsPerHit,
        burstRate: stripBursts,
        analysis,
        startFrame: anchor,
        durationFrames: Math.max(1, base.start + base.duration - anchor)
      }

      const flashes = planStrips(options).filter(
        (f) => f.startFrame >= base.start && f.startFrame < base.start + base.duration
      )
      if (flashes.length === 0) {
        notify('No room for any flashes over that shot', 'info')
        return
      }

      const cleared = clearGenerated(current, STRIP_RULE)
      const clips = stripClips(flashes, options, overlay.id, base.assetId).map((clip) => ({
        ...clip,
        // Back into the file's own coordinates, since the strips were measured
        // inside the shot's visible rectangle.
        crop: {
          ...clip.crop!,
          x: clip.crop!.x + region.x,
          y: clip.crop!.y + region.y
        }
      }))
      get().update(() => ({ ...cleared, clips: [...cleared.clips, ...clips] }))
      notify(
        analysis ? `${clips.length} flashes on the beat grid` : `${clips.length} flashes`,
        'info'
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      set({ stripsBuilding: false })
    }
  },

  putBehindSubject: (clipId) => {
    const { project, notify } = get()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip) return
    const result = sandwich(project, clip)
    if (!result.frontClipId) {
      notify(result.reason ?? 'Could not put that behind the subject', 'info')
      return
    }
    get().update(() => result.project)
    notify('The photo is now two clips — its subject sits above the text', 'info')
  },

  removeSandwich: (frontClipId) => get().update((p) => unsandwich(p, frontClipId)),

  setClipSpeed: (clipId, speed, smoothSlow) => {
    // The rule itself lives in the shared layer, where it can be tested; this
    // is only the wiring.
    get().update((p) => withClipSpeed(p, clipId, speed, smoothSlow))
  },

  setClipDuration: (clipId, frames) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c
        const asset = p.assets.find((a) => a.id === c.assetId)
        // A still can be held as long as you like; a video or a sound cannot be
        // stretched past what is left of it after its in-point.
        // Divided by speed: at half speed a second of footage covers two
        // seconds of timeline, so the ceiling is twice as far away.
        const ceiling = maxDurationAtSpeed(c, asset, clipSpeed(c))
        return { ...c, duration: Math.max(1, Math.min(ceiling, Math.round(frames))) }
      })
    }))
  },

  setPath: (clipId, path) => {
    get().update((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c
        if (!path || path.length === 0) {
          const { path: _dropped, ...rest } = c
          return rest
        }
        return { ...c, path }
      })
    }))
  },

  addWaypoint: (clipId) => {
    const { project, playhead, notify } = get()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip) return
    const frame = playhead - clip.start
    if (frame < 0 || frame > clip.duration) {
      notify('Move the playhead over the clip first', 'info')
      return
    }
    // Whatever the clip is doing right now becomes the waypoint: its path
    // position if it has one, otherwise its resting offset.
    const at = clip.path ? pathAt(clip.path, frame, clip.duration) : null
    const point = {
      frame,
      x: at?.x ?? clip.transform?.x ?? 0,
      y: at?.y ?? clip.transform?.y ?? 0
    }
    get().setPath(clipId, normalisePath([...(clip.path ?? []), point], clip.duration))
  },

  setSourceRange: (clipId, inPoint, outPoint) => {
    get().update((p) => {
      const clip = p.clips.find((c) => c.id === clipId)
      if (!clip) return p
      const asset = p.assets.find((a) => a.id === clip.assetId)
      if (!asset) return p

      const start = Math.max(0, Math.min(Math.round(inPoint), asset.durationFrames - 1))
      const end = Math.max(start + 1, Math.min(Math.round(outPoint), asset.durationFrames))
      return {
        ...p,
        // The clip keeps its timeline position; only which part of the source it
        // shows changes.
        clips: p.clips.map((c) =>
          c.id === clipId ? { ...c, inPoint: start, duration: end - start } : c
        )
      }
    })
  },

  setTransition: (clipId, transitionId, durationFrames) => {
    // Mask wipes come from the asset library and are not in the built-in table,
    // so a missing definition is not a reason to refuse.
    const definition = transitionById(transitionId)
    get().update((p) =>
      addTransitionTo(p, clipId, transitionId, durationFrames ?? definition?.defaultFrames ?? 14)
    )
  },

  clearTransition: (clipId) => get().update((p) => removeTransitionFrom(p, clipId)),

  addTrack: (kind) => get().update((p) => addTrackTo(p, kind)),

  removeTrack: (trackId) => {
    get().update((p) => removeTrackFrom(p, trackId))
    set((s) => ({
      selectedClipId:
        s.project.clips.some((c) => c.id === s.selectedClipId) ? s.selectedClipId : null
    }))
  },

  toggleTrackMuted: (trackId) =>
    get().update((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t))
    })),

  toggleTrackHidden: (trackId) =>
    get().update((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, hidden: !t.hidden } : t))
    })),

  setCaptionStyle: (styleId) =>
    get().update((p) => {
      /*
       * A preset resets the typography and keeps the look.
       *
       * Overrides mostly belong to the preset they were made against — a font
       * size chosen for Bold Centre means nothing on Clean — so carrying them
       * across produces styles nobody chose. The look and the animation are the
       * exception, and deliberately so: a style is a recipe and a preset is a
       * layout, kept independent everywhere else in the app. Wiping them made
       * picking a preset silently throw away the two choices most likely to
       * have been made on purpose.
       */
      const { textStyleId, animationId } = (p.captions.overrides ?? {}) as {
        textStyleId?: string
        animationId?: string
      }
      const kept: Record<string, unknown> = {}
      if (textStyleId !== undefined) kept.textStyleId = textStyleId
      if (animationId !== undefined) kept.animationId = animationId
      return { ...p, captions: { ...p.captions, styleId, overrides: kept } }
    }),

  setCaptionOverride: (key, value) =>
    get().update((p) => {
      /*
       * Choosing "None" removes the override rather than storing undefined.
       *
       * Both style pickers report "None" as undefined, and writing that under
       * the key left it present-but-empty — so `hasOverrides` stayed true and
       * the Reset button sat permanently lit for a caption that had been reset
       * back to its preset already.
       */
      const next = { ...(p.captions.overrides ?? {}) }
      if (value === undefined) delete next[key]
      else next[key] = value
      return { ...p, captions: { ...p.captions, overrides: next } }
    }),

  clearCaptionOverrides: () =>
    get().update((p) => ({ ...p, captions: { ...p.captions, overrides: {} } })),

  setCaptionsEnabled: (enabled) =>
    get().update((p) => ({ ...p, captions: { ...p.captions, enabled } })),

  setPlayhead: (frame) => {
    const max = Math.max(0, projectDuration(get().project))
    set({ playhead: Math.max(0, Math.min(Math.round(frame), max)) })
  },
  setPlaying: (playing) => set({ playing }),
  setLoop: (loop) => set({ loop }),
  select: (clipId) => set({ selectedClipId: clipId }),

  revealClip: (clipId) => {
    const { project, playhead } = get()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip) return
    set({ selectedClipId: clipId })
    /*
     * Move the playhead onto it, if it is not already.
     *
     * A clip is only drawn while the playhead is over it, and the on-picture
     * handles can only exist over a frame that is actually being drawn. So
     * adding a sticker anywhere other than the current time selected something
     * with no visible box, no corner handles and nothing to drag — while the
     * Inspector's brightness and LUT kept working, because those read the
     * selection directly. That combination reads exactly like "sizing is
     * broken", and it was reported as such.
     *
     * Nothing moves when the playhead is already over the clip, which is the
     * common case.
     */
    if (!clipCoversFrame(clip, playhead)) get().setPlayhead(clip.start)
  },
  setZoom: (zoom) => set({ zoom: Math.max(0.05, Math.min(12, zoom)) }),
  setPreviewMode: (previewMode) => set({ previewMode }),
  setSplitRatio: (ratio) => {
    // Snap to the ends and the exact middle: a half-and-half compare is the
    // whole point, and hitting 0.500 by hand is fiddly.
    const clamped = Math.max(0, Math.min(1, ratio))
    const snapped = [0, 0.5, 1].find((target) => Math.abs(clamped - target) < 0.035)
    set({ splitRatio: snapped ?? clamped })
  },

  setJobs: (jobs) => set({ jobs }),

  setTranscribeProgress: (assetId, progress, message) =>
    set((s) => ({ transcribing: { ...s.transcribing, [assetId]: { progress, message } } })),

  setSidecar: (ready, error = null) => set({ sidecarReady: ready, sidecarError: error }),

  /**
   * Cut a photo into depth planes.
   *
   * The bake lives on the project keyed by asset, so two clips of the same photo
   * share it and a save/load keeps it. A photo that will not separate is stored
   * too — that is a real answer, and storing it stops us re-baking a flat-lay
   * every time the reel is rebuilt.
   */
  bakeParallax: async (assetId) => {
    const { project, notify } = get()
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset || asset.kind !== 'image') {
      notify('Parallax works on photos', 'info')
      return null
    }
    if (get().baking[assetId]) return null

    set((s) => ({ baking: { ...s.baking, [assetId]: { progress: null } } }))
    try {
      const bake = await window.forge.bakeParallax({ assetId, path: asset.path })
      get().update((p) => ({
        ...p,
        parallax: { ...(p.parallax ?? {}), [assetId]: bake }
      }))
      if (!bake.separated) {
        notify(bake.reason ?? `${asset.name} is too flat to separate`, 'info')
      }
      return bake
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/cancel/i.test(message)) notify(message)
      return null
    } finally {
      set((s) => {
        const next = { ...s.baking }
        delete next[assetId]
        return { baking: next }
      })
    }
  },

  cancelBake: (assetId) => {
    void window.forge.cancelParallax(assetId)
  },

  setBakeProgress: (assetId, progress, message) =>
    set((s) =>
      s.baking[assetId]
        ? { baking: { ...s.baking, [assetId]: { progress, message } } }
        : s
    ),

  transcribeAsset: async (assetId) => {
    const { project, notify } = get()
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) return
    if (asset.kind === 'image') {
      notify('Images have no audio to transcribe', 'info')
      return
    }
    if (get().transcribing[assetId]) return

    set((s) => ({ transcribing: { ...s.transcribing, [assetId]: { progress: null } } }))
    try {
      const transcript: Transcript = await window.forge.transcribe({
        assetId,
        path: asset.path
      })
      get().update((p) => ({
        ...p,
        transcripts: { ...p.transcripts, [assetId]: transcript }
      }))
      notify(`Transcribed ${asset.name} — ${transcript.segments.length} segments`, 'info')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/cancel/i.test(message)) notify(message)
    } finally {
      set((s) => {
        const next = { ...s.transcribing }
        delete next[assetId]
        return { transcribing: next }
      })
    }
  },

  cancelTranscribe: (assetId) => {
    void window.forge.cancelTranscribe(assetId)
  },

  newProject: () =>
    set({
      project: emptyProject(),
      projectPath: null,
      decisions: [],
      dirty: false,
      playhead: 0,
      selectedClipId: null,
      past: [],
      future: []
    }),

  loadProject: (project, path, decisions) =>
    set({
      project,
      projectPath: path,
      decisions,
      dirty: false,
      playhead: 0,
      selectedClipId: null,
      /*
       * The aspect comes back with the project.
       *
       * `aspect` is a slice of its own, initialised to 16:9, and opening a file
       * never touched it — while every reframe decision in the renderer reads
       * ASPECTS[aspect] rather than project.settings. So a saved 9:16 project
       * reopened into a fresh session looked right, and then the next clip
       * dropped onto it was cropped to a horizontal rectangle inside a vertical
       * frame, for no reason the user could see.
       */
      aspect: aspectOf(project.settings),
      past: [],
      future: []
    }),

  markSaved: (path) => set({ projectPath: path, dirty: false })
}))

/** Snapshot held between begin() and commit(); null when no transaction is open. */
let pendingSnapshot: Project | null = null
