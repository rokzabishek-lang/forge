import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { Eye, EyeOff, Plus, Trash2, Volume2, VolumeX } from 'lucide-react'
import { clipEnd, formatTimecode, projectDuration, MAX_TRACKS } from '@shared/timeline'
import { useEditor } from '../store'

type DragMode = 'move' | 'trim-start' | 'trim-end'

const TRACK_HEIGHT = 62
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
  const trimClipStart = useEditor((s) => s.trimClipStart)
  const trimClipEnd = useEditor((s) => s.trimClipEnd)
  const begin = useEditor((s) => s.begin)
  const commit = useEditor((s) => s.commit)
  const addTrack = useEditor((s) => s.addTrack)
  const removeTrack = useEditor((s) => s.removeTrack)
  const toggleTrackMuted = useEditor((s) => s.toggleTrackMuted)
  const toggleTrackHidden = useEditor((s) => s.toggleTrackHidden)

  const laneRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    mode: DragMode
    clipId: string
    startX: number
    origin: Clip
  } | null>(null)

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
        moveClip(state.clipId, snap(origin.start + deltaFrames, ownEdges))
      } else if (state.mode === 'trim-start') {
        trimClipStart(state.clipId, snap(origin.start + deltaFrames, ownEdges))
      } else {
        trimClipEnd(state.clipId, snap(clipEnd(origin) + deltaFrames, ownEdges))
      }
    },
    [zoom, snap, moveClip, trimClipStart, trimClipEnd]
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

          {project.tracks.map((track, index) => {
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

                {/* Layer order matters for compositing: higher video track wins. */}
                <span className="ml-auto shrink-0 text-[9px] text-ink-700">
                  {track.kind === 'video' ? `L${index + 1}` : ''}
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

            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`relative border-b border-ink-800 ${
                  track.hidden || track.muted ? 'opacity-40' : ''
                }`}
                style={{ height: TRACK_HEIGHT }}
                onPointerDown={() => select(null)}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((clip) => {
                    const asset = project.assets.find((a) => a.id === clip.assetId)
                    const selected = clip.id === selectedClipId
                    return (
                      <div
                        key={clip.id}
                        className={`absolute top-1.5 bottom-1.5 overflow-hidden rounded-md border text-[11px] transition-colors ${
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
                        {/* A transition overlaps the clip before it; mark where. */}
                        {clip.transitionIn && (
                          <div
                            className="pointer-events-none absolute left-0 top-0 flex h-full items-center justify-center overflow-hidden border-r-2 border-flame-400 bg-flame-500/70"
                            style={{ width: Math.max(4, clip.transitionIn.durationFrames * zoom) }}
                            title={`${clip.transitionIn.id} · ${clip.transitionIn.durationFrames} frames`}
                          >
                            {clip.transitionIn.durationFrames * zoom > 26 && (
                              <span className="text-[9px] font-semibold text-ink-950">⇥</span>
                            )}
                          </div>
                        )}
                        <div className="truncate px-2 pt-1 text-ink-200">{asset?.name ?? 'missing'}</div>
                        <div className="px-2 text-[10px] text-ink-400">
                          {formatTimecode(clip.duration, fps)}
                        </div>

                        {/* Trim handles. Wide enough to hit, narrow enough not to eat the body. */}
                        <div
                          className="absolute left-0 top-0 h-full w-2 cursor-w-resize bg-transparent hover:bg-flame-500/60"
                          onPointerDown={startDrag('trim-start', clip)}
                          onPointerMove={onClipMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        />
                        <div
                          className="absolute right-0 top-0 h-full w-2 cursor-e-resize bg-transparent hover:bg-flame-500/60"
                          onPointerDown={startDrag('trim-end', clip)}
                          onPointerMove={onClipMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        />
                      </div>
                    )
                  })}
              </div>
            ))}

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
