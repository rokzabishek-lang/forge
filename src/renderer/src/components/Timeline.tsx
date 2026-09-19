import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Clip, Track } from '@shared/timeline'
import { Eye, EyeOff, Plus, Trash2, Volume2, VolumeX } from 'lucide-react'
import {
  clipEnd,
  formatTimecode,
  laneOrder,
  projectDuration,
  nearestTransitionTarget,
  MAX_TRACKS
} from '@shared/timeline'
import { useEditor } from '../store'
import { useCatalog } from '../catalog'
import { VolumeEnvelope } from './VolumeEnvelope'
import { ClipWaveform } from './ClipWaveform'
import { FadeHandles } from './FadeHandles'
import { acceptsKind, isAssetDrag, readDragPayload, type DragPayload } from '../dragPayload'

type DragMode = 'move' | 'trim-start' | 'trim-end'

const TRACK_HEIGHT = 62
/** The sticky ruler above the lanes, `h-7`. Lane 0 starts below it. */
const RULER_HEIGHT = 28
const HEADER_WIDTH = 128
/** Snap threshold in screen pixels — converted to frames using the zoom. */
const SNAP_PX = 7

function useSnapTargets(): number[] {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const targets = [0, playhead]
  for (const clip of project.clips) targets.push(clip.start, clipEnd(clip))
  return targets
}

export function Timeline(): ReactNode {
  const project = useEditor((s) => s.project)
  const zoom = useEditor((s) => s.zoom)
  const playhead = useEditor((s) => s.playhead)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const select = useEditor((s) => s.select)
  const moveClip = useEditor((s) => s.moveClip)
  const placePoolAsset = useEditor((s) => s.placePoolAsset)
  const trimClipStart = useEditor((s) => s.trimClipStart)
  const trimClipEnd = useEditor((s) => s.trimClipEnd)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)
  const addTrack = useEditor((s) => s.addTrack)
  const removeTrack = useEditor((s) => s.removeTrack)
  const toggleTrackMuted = useEditor((s) => s.toggleTrackMuted)
  const toggleTrackHidden = useEditor((s) => s.toggleTrackHidden)
  const placeLibraryAsset = useEditor((s) => s.placeLibraryAsset)
  const placeTitle = useEditor((s) => s.placeTitle)
  const setTransition = useEditor((s) => s.setTransition)
  const notify = useEditor((s) => s.notify)
  const clearTransition = useEditor((s) => s.clearTransition)
  const allTransitions = useCatalog((s) => s.transitions)
  const [dropTarget, setDropTarget] = useState<{
    trackId: string
    frame: number
    /** Set while dragging a transition: the cut it would snap to. */
    cutFrame: number | null
  } | null>(null)

  const laneRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    mode: DragMode
    clipId: string
    startX: number
    origin: Clip
  } | null>(null)

  /**
   * Which lane the pointer is over, or null when it is off the stack.
   *
   * Dragging a clip only ever read `clientX`, so a clip could never leave the
   * track it was born on. That is the whole of "no freedom to move between
   * layers" — and it is why picture-in-picture felt pointless, since there was
   * no way to get a second video above a first one to be in front OF.
   */
  const lanesRef = useRef<Track[]>([])

  const laneAt = useCallback(
    (clientY: number): Track | null => {
      const box = laneRef.current?.getBoundingClientRect()
      if (!box) return null
      const index = Math.floor((clientY - box.top - RULER_HEIGHT) / TRACK_HEIGHT)
      return lanesRef.current[index] ?? null
    },
    []
  )

  /**
   * A transition attaches to a cut, everything else becomes a clip.
   *
   * Dropping a transition onto a clip applies it to that clip's incoming edge,
   * which is the only place a transition can live — so it is rejected anywhere
   * else rather than silently doing nothing.
   */
  const handleDrop = useCallback(
    async (
      payload: DragPayload,
      trackId: string,
      trackKind: 'video' | 'audio',
      frame: number
    ): Promise<void> => {
      if (!acceptsKind(payload, trackKind)) {
        notify(
          payload.kind === 'sfx'
            ? 'Sounds go on an audio track'
            : 'That belongs on a video track',
          'info'
        )
        return
      }

      if (payload.kind === 'transition') {
        // Snap to the nearest cut within half a second of the drop.
        const tolerance = Math.round(useEditor.getState().project.settings.fps / 2)
        const result = nearestTransitionTarget(
          useEditor.getState().project,
          trackId,
          frame,
          tolerance
        )
        if (!result.clip) {
          // Previously this failed silently, which looked exactly like the drop
          // not registering at all.
          notify(result.reason, 'info')
          return
        }
        if (!payload.transitionId) return
        setTransition(result.clip.id, payload.transitionId)
        select(result.clip.id)
        notify(`${payload.name} applied`, 'info')
        return
      }

      // Already imported: reuse the asset rather than reading the file again,
      // which would put a second copy of the same photograph in the pool.
      if (payload.kind === 'media' && payload.assetId) {
        placePoolAsset(payload.assetId, trackId, frame)
        return
      }

      // Titles are generated from a template rather than placed as a file.
      if (payload.kind === 'title') {
        await placeTitle(payload.file, payload.name, trackId, frame)
        return
      }

      await placeLibraryAsset(payload.file, payload.name, trackId, frame)
    },
    [notify, placeLibraryAsset, placePoolAsset, placeTitle, setTransition, select]
  )

  const snapTargets = useSnapTargets()
  const fps = project.settings.fps
  const duration = Math.max(projectDuration(project), Math.round(fps * 10))
  const laneWidth = duration * zoom + 400

  const snap = useCallback(
    (frame: number, ignore: number[]): number => {
      const threshold = SNAP_PX / zoom
      let best = frame
      let bestDistance = threshold
      for (const target of snapTargets) {
        if (ignore.includes(target)) continue
        const distance = Math.abs(target - frame)
        if (distance < bestDistance) {
          bestDistance = distance
          best = target
        }
      }
      return Math.round(best)
    },
    [snapTargets, zoom]
  )

  const frameFromEvent = useCallback(
    (clientX: number): number => {
      const lane = laneRef.current
      if (!lane) return 0
      const rect = lane.getBoundingClientRect()
      return Math.max(0, Math.round((clientX - rect.left + lane.scrollLeft) / zoom))
    },
    [zoom]
  )

  const onRulerPointer = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault()
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      setPlayhead(frameFromEvent(event.clientX))
    },
    [frameFromEvent, setPlayhead]
  )

  const onRulerMove = useCallback(
    (event: ReactPointerEvent) => {
      if (event.buttons !== 1) return
      setPlayhead(frameFromEvent(event.clientX))
    },
    [frameFromEvent, setPlayhead]
  )

  const startDrag = useCallback(
    (mode: DragMode, clip: Clip) => (event: ReactPointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
      drag.current = { mode, clipId: clip.id, startX: event.clientX, origin: { ...clip } }
      select(clip.id)
      begin()
    },
    [select, begin]
  )

  const onClipMove = useCallback(
    (event: ReactPointerEvent) => {
      const state = drag.current
      if (!state) return
      const deltaFrames = (event.clientX - state.startX) / zoom
      const origin = state.origin
      const ownEdges = [origin.start, clipEnd(origin)]

      if (state.mode === 'move') {
        /*
         * Sideways in time, upwards in layers — one gesture, both axes.
         *
         * Only onto a lane of the same kind: a video has nothing to be on an
         * audio track, and silently dropping it there would look like the drag
         * failing. A locked lane is refused for the same reason. In either
         * case the clip keeps the track it has and the horizontal move still
         * happens, so the drag never feels stuck.
         */
        const over = laneAt(event.clientY)
        const originKind = lanesRef.current.find((t) => t.id === origin.trackId)?.kind
        const target = over && over.kind === originKind && !over.locked ? over.id : undefined
        moveClip(state.clipId, snap(origin.start + deltaFrames, ownEdges), target)
      } else if (state.mode === 'trim-start') {
        trimClipStart(state.clipId, snap(origin.start + deltaFrames, ownEdges))
      } else {
        trimClipEnd(state.clipId, snap(clipEnd(origin) + deltaFrames, ownEdges))
      }
    },
    [zoom, snap, moveClip, trimClipStart, trimClipEnd, laneAt]
  )

  const endDrag = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    commit()
  }, [commit])

  /* --------------------------------------------------------------- ruler */

  const secondsStep = zoom * fps > 90 ? 1 : zoom * fps > 26 ? 5 : zoom * fps > 9 ? 15 : 60
  const ticks: number[] = []
  for (let f = 0; f <= duration + fps * secondsStep; f += fps * secondsStep) ticks.push(f)

  // Highest video layer at the top, the way every NLE shows it. See laneOrder.
  const lanes = laneOrder(project.tracks)
  // Read by the drag handler, which is created before `lanes` exists and must
  // not be rebuilt on every track change.
  lanesRef.current = lanes

  return (
    <div className="flex h-full flex-col border-t border-ink-800 bg-ink-900">
      <div className="flex flex-1 overflow-hidden">
        {/* Track headers stay put while the lane scrolls. */}
        <div className="w-[128px] shrink-0 overflow-y-auto border-r border-ink-800 bg-ink-850">
          <div className="flex h-7 items-center justify-between border-b border-ink-800 px-2">
            <span className="text-[9.5px] uppercase tracking-wide text-ink-600">Tracks</span>
            <div className="flex gap-0.5">
              <button
                onClick={() => addTrack('video')}
                disabled={project.tracks.length >= MAX_TRACKS}
                title="Add a video track"
                className="flex items-center rounded px-1 text-[9.5px] text-ink-400 hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
              >
                <Plus size={9} />V
              </button>
              <button
                onClick={() => addTrack('audio')}
                disabled={project.tracks.length >= MAX_TRACKS}
                title="Add an audio track"
                className="flex items-center rounded px-1 text-[9.5px] text-ink-400 hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
              >
                <Plus size={9} />A
              </button>
            </div>
          </div>

          {lanes.map((track) => {
            const isOnlyVideo =
              track.kind === 'video' && project.tracks.filter((t) => t.kind === 'video').length === 1
            return (
              <div
                key={track.id}
                className="group flex items-center gap-1 border-b border-ink-800 px-2 text-[11px] text-ink-400"
                style={{ height: TRACK_HEIGHT }}
              >
                <span
                  className={`w-7 shrink-0 font-medium ${
                    track.hidden || track.muted ? 'text-ink-600' : 'text-ink-200'
                  }`}
                >
                  {track.name}
                </span>

                {track.kind === 'video' ? (
                  <button
                    onClick={() => toggleTrackHidden(track.id)}
                    title={track.hidden ? 'Hidden — excluded from export' : 'Visible'}
                    className={`rounded p-0.5 hover:bg-ink-800 ${
                      track.hidden ? 'text-amber-500' : 'text-ink-600 hover:text-ink-200'
                    }`}
                  >
                    {track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                ) : (
                  <button
                    onClick={() => toggleTrackMuted(track.id)}
                    title={track.muted ? 'Muted — excluded from export' : 'Audible'}
                    className={`rounded p-0.5 hover:bg-ink-800 ${
                      track.muted ? 'text-amber-500' : 'text-ink-600 hover:text-ink-200'
                    }`}
                  >
                    {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                  </button>
                )}

                {/* The track above composites over the one below, as in Resolve. */}
                <span className="ml-auto shrink-0 text-[9px] text-ink-700">
                  {track.kind === 'video' && track.id === lanes[0]?.id ? 'top' : ''}
                </span>

                <button
                  onClick={() => removeTrack(track.id)}
                  disabled={isOnlyVideo}
                  title={isOnlyVideo ? 'The last video track cannot be removed' : 'Remove track and its clips'}
                  className="shrink-0 rounded p-0.5 text-ink-700 opacity-0 transition group-hover:opacity-100 hover:bg-ink-800 hover:text-red-400 disabled:opacity-0"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            )
          })}
        </div>

        <div ref={laneRef} className="relative flex-1 overflow-x-auto overflow-y-hidden">
          <div style={{ width: laneWidth }} className="relative">
            <div
              className="sticky top-0 z-20 h-7 cursor-ew-resize select-none border-b border-ink-800 bg-ink-850"
              onPointerDown={onRulerPointer}
              onPointerMove={onRulerMove}
            >
              {ticks.map((frame) => (
                <div
                  key={frame}
                  className="pointer-events-none absolute top-0 h-full border-l border-ink-700 pl-1 text-[10px] leading-7 text-ink-600"
                  style={{ left: frame * zoom }}
                >
                  {formatTimecode(frame, fps)}
                </div>
              ))}
            </div>

            {lanes.map((track) => (
              <div
                key={track.id}
                className={`relative border-b border-ink-800 ${
                  track.hidden || track.muted ? 'opacity-40' : ''
                } ${dropTarget?.trackId === track.id ? 'bg-flame-500/10' : ''}`}
                style={{ height: TRACK_HEIGHT }}
                onPointerDown={() => select(null)}
                onDragOver={(e) => {
                  if (!isAssetDrag(e)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  const frame = frameFromEvent(e.clientX)
                  // dataTransfer contents are unreadable during dragover, so the
                  // snap preview is computed for any drag and simply ignored for
                  // kinds that do not snap.
                  const snap = nearestTransitionTarget(
                    project,
                    track.id,
                    frame,
                    Math.round(project.settings.fps / 2)
                  )
                  setDropTarget({
                    trackId: track.id,
                    frame,
                    cutFrame: snap.clip ? snap.clip.start : null
                  })
                }}
                onDragLeave={() =>
                  setDropTarget((current) => (current?.trackId === track.id ? null : current))
                }
                onDrop={(e) => {
                  e.preventDefault()
                  setDropTarget(null)
                  const payload = readDragPayload(e)
                  if (!payload) return
                  void handleDrop(payload, track.id, track.kind, frameFromEvent(e.clientX))
                }}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id && c.transitionIn)
                  .map((clip) => {
                    const transition = clip.transitionIn!
                    const width = Math.max(18, transition.durationFrames * zoom)
                    const selected = clip.id === selectedClipId
                    const label =
                      allTransitions.find((t) => t.id === transition.id)?.label ?? transition.id
                    return (
                      <button
                        key={`tr-${clip.id}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          select(clip.id)
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          clearTransition(clip.id)
                        }}
                        title={`${label} · ${transition.durationFrames} frames — click to edit, double-click to remove`}
                        // Centred on the cut: a transition consumes time from
                        // both clips, so showing it inside only one misrepresents it.
                        className={`absolute top-1 z-10 flex items-center justify-center overflow-hidden rounded border text-[9px] font-semibold transition-colors ${
                          selected
                            ? 'border-flame-300 bg-flame-500 text-ink-950'
                            : 'border-flame-400 bg-flame-500/85 text-ink-950 hover:bg-flame-400'
                        }`}
                        style={{
                          left: clip.start * zoom,
                          width,
                          height: TRACK_HEIGHT - 8
                        }}
                      >
                        <span
                          className="pointer-events-none absolute inset-0 opacity-30"
                          style={{
                            backgroundImage:
                              'repeating-linear-gradient(45deg, rgba(0,0,0,0.7) 0 2px, transparent 2px 5px)'
                          }}
                        />
                        <span className="relative">{width > 46 ? label : '⋈'}</span>
                      </button>
                    )
                  })}

                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((clip) => {
                    const asset = project.assets.find((a) => a.id === clip.assetId)
                    const selected = clip.id === selectedClipId
                    return (
                      <div
                        key={clip.id}
                        className={`group/clip absolute top-1.5 bottom-1.5 overflow-hidden rounded-md border text-[11px] transition-colors ${
                          selected
                            ? 'border-flame-500 bg-flame-500/25'
                            : 'border-ink-600 bg-ink-700/70 hover:bg-ink-700'
                        }`}
                        style={{ left: clip.start * zoom, width: Math.max(6, clip.duration * zoom) }}
                        onPointerDown={startDrag('move', clip)}
                        onPointerMove={onClipMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                      >
                        {/*
                          The sound itself, underneath everything.

                          First in the clip so it paints behind the name and
                          behind the volume line — it is what they are both
                          about, not something to read over.
                        */}
                        {asset?.hasAudio && (
                          <ClipWaveform
                            clip={clip}
                            asset={asset}
                            zoom={zoom}
                            height={TRACK_HEIGHT - 12}
                            fps={fps}
                            selected={selected}
                          />
                        )}

                        <div className="pointer-events-none relative">
                          <div className="truncate px-2 pt-1 text-ink-200 [text-shadow:0_1px_2px_rgb(10_12_15/0.9)]">
                            {asset?.name ?? 'missing'}
                          </div>
                          <div className="px-2 text-[10px] text-ink-400 [text-shadow:0_1px_2px_rgb(10_12_15/0.9)]">
                            {formatTimecode(clip.duration, fps)}
                          </div>
                        </div>

                        {/*
                          The volume line, on the clip that makes the sound.

                          Only where there IS sound: a line over a photograph
                          is a control that cannot do anything. Its container
                          takes no pointer events — only the line and its
                          points do — so the body still drags and the edges
                          still trim.
                        */}
                        {asset?.hasAudio && (
                          <VolumeEnvelope
                            clip={clip}
                            zoom={zoom}
                            height={TRACK_HEIGHT - 12}
                          />
                        )}

                        {/*
                          Trim handles. Wide enough to hit, narrow enough not to
                          eat the body — and above the volume line, so an edge
                          the line happens to pass through still trims.
                        */}
                        <div
                          className="absolute left-0 top-0 z-20 h-full w-2 cursor-w-resize bg-transparent hover:bg-flame-500/60"
                          onPointerDown={startDrag('trim-start', clip)}
                          onPointerMove={onClipMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        />
                        <div
                          className="absolute right-0 top-0 z-20 h-full w-2 cursor-e-resize bg-transparent hover:bg-flame-500/60"
                          onPointerDown={startDrag('trim-end', clip)}
                          onPointerMove={onClipMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        />

                        {/*
                          Fade grips, above even the trim handles.

                          They overlap the top of both trim strips by a few
                          pixels, which is the same compromise Resolve makes —
                          the corner is where everyone reaches for a fade, and
                          the rest of the strip's height still trims. They only
                          become a target when the clip is hovered or selected,
                          so a timeline of clips nobody is fading loses nothing.
                        */}
                        {asset?.hasAudio && (
                          <FadeHandles
                            clip={clip}
                            zoom={zoom}
                            height={TRACK_HEIGHT - 12}
                            selected={selected}
                          />
                        )}
                      </div>
                    )
                  })}
              </div>
            ))}

            {dropTarget && (
              <div
                className={`pointer-events-none absolute top-7 z-20 ${
                  dropTarget.cutFrame === null ? 'w-0.5 bg-flame-400' : 'w-1 bg-flame-400'
                }`}
                style={{
                  left: (dropTarget.cutFrame ?? dropTarget.frame) * zoom,
                  height: project.tracks.length * TRACK_HEIGHT
                }}
              />
            )}

            <div
              className="pointer-events-none absolute top-0 z-30 w-px bg-flame-500"
              style={{ left: playhead * zoom, height: 28 + project.tracks.length * TRACK_HEIGHT }}
            >
              <div className="absolute -left-1.5 top-0 size-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-flame-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export { HEADER_WIDTH }
