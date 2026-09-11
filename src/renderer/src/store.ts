import { create } from 'zustand'
import type { Job } from '@shared/types'
import type { Clip, CropRect, MediaAsset, Project } from '@shared/timeline'
import { transitionById } from '@shared/transitions/registry'
import {
  addTransition as addTransitionTo,
  removeTransition as removeTransitionFrom,
  addTrack as addTrackTo,
  clipEnd,
  clipsOnTrack,
  emptyProject,
  findFreeSlot,
  projectDuration,
  removeTrack as removeTrackFrom,
  splitClip,
  trimEnd,
  trimStart
} from '@shared/timeline'
import type { DecisionRecord } from '@shared/project'
import type { Transcript } from '@shared/transcript'

export const ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: 'Landscape' },
  '9:16': { width: 1080, height: 1920, label: 'Vertical' },
  '1:1': { width: 1080, height: 1080, label: 'Square' }
} as const

export type AspectKey = keyof typeof ASPECTS

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

  return {
    x: Math.round((source.w - width) / 2),
    y: Math.round((source.h - height) / 2),
    width,
    height
  }
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

  jobs: Job[]
  notices: Notice[]

  /** Per-asset transcription progress; presence means "in flight". */
  transcribing: Record<string, { progress: number | null; message?: string }>
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

  /** Trim in SOURCE frames — what the waveform trimmer manipulates. */
  setSourceRange: (clipId: string, inPoint: number, outPoint: number) => void
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
  setZoom: (zoom: number) => void
  setPreviewMode: (mode: 'source' | 'output') => void

  setJobs: (jobs: Job[]) => void
  transcribeAsset: (assetId: string) => Promise<void>
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
  splitRatio: 1,

  jobs: [],
  notices: [],

  transcribing: {},
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
    set({ selectedClipId: clip.id })
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
      const free = findFreeSlot(p, targetTrack, snapped, clip.duration, clipId)
      return {
        ...p,
        clips: p.clips.map((c) =>
          c.id === clipId ? { ...c, start: free, trackId: targetTrack } : c
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
    get().update((p) => ({
      ...p,
      settings: { ...p.settings, width: ASPECTS[aspect].width, height: ASPECTS[aspect].height },
      clips: p.clips.map((c) => {
        const asset = p.assets.find((a) => a.id === c.assetId)
        if (!asset || asset.kind === 'audio') return c
        return { ...c, crop: solveCrop(asset, aspect) }
      })
    }))
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
      const existing = project.assets.find((a) => a.path === audition.path)
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
      get().update((p) => ({
        ...p,
        clips: [
          ...p.clips,
          {
            id: clipId,
            assetId: asset!.id,
            trackId: track.id,
            // Land where the playhead is: placing a sound is almost always
            // "here", not "at the end".
            start: findFreeSlot(p, track.id, playhead, duration),
            duration,
            inPoint,
            volume: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
            color: { brightness: 0, contrast: 1, saturation: 1 }
          }
        ]
      }))
      set({ selectedClipId: clipId })
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
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
    const definition = transitionById(transitionId)
    if (!definition) return
    get().update((p) =>
      addTransitionTo(p, clipId, transitionId, durationFrames ?? definition.defaultFrames)
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
    // Overrides belong to the preset they were made against; carrying them onto
    // a different preset produces styles nobody chose.
    get().update((p) => ({ ...p, captions: { ...p.captions, styleId, overrides: {} } })),

  setCaptionOverride: (key, value) =>
    get().update((p) => ({
      ...p,
      captions: { ...p.captions, overrides: { ...(p.captions.overrides ?? {}), [key]: value } }
    })),

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
      past: [],
      future: []
    }),

  markSaved: (path) => set({ projectPath: path, dirty: false })
}))

/** Snapshot held between begin() and commit(); null when no transaction is open. */
let pendingSnapshot: Project | null = null
