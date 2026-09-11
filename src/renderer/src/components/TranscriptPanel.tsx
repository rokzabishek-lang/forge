import { useMemo, type ReactNode } from 'react'
import { formatTimecode, secondsToFrames } from '@shared/timeline'
import type { Segment } from '@shared/transcript'
import { useEditor } from '../store'

/**
 * Transcript for the selected clip's asset, with click-to-seek.
 *
 * Segment times are milliseconds into the SOURCE, so mapping one to the timeline
 * has to go through the clip's in-point — a segment at 10s of source is not at
 * 10s of timeline unless the clip is untrimmed and starts at zero.
 */
export function TranscriptPanel(): ReactNode {
  const project = useEditor((s) => s.project)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const playhead = useEditor((s) => s.playhead)
  const setPlayhead = useEditor((s) => s.setPlayhead)

  const clip = project.clips.find((c) => c.id === selectedClipId) ?? null
  const transcript = clip ? project.transcripts[clip.assetId] ?? null : null
  const fps = project.settings.fps

  const sourceMsToFrame = useMemo(
    () => (ms: number): number => {
      if (!clip) return 0
      return clip.start + (secondsToFrames(ms / 1000, fps) - clip.inPoint)
    },
    [clip, fps]
  )

  const activeId = useMemo(() => {
    if (!clip || !transcript) return null
    // Playhead -> source ms, the inverse of the mapping above.
    const sourceMs = ((playhead - clip.start + clip.inPoint) / fps) * 1000
    return (
      transcript.segments.find((s) => sourceMs >= s.startMs && sourceMs < s.endMs)?.id ?? null
    )
  }, [clip, transcript, playhead, fps])

  if (!clip) {
    return <Empty>Select a clip to see its transcript</Empty>
  }
  if (!transcript) {
    return <Empty>No transcript yet — use the caption button in Media</Empty>
  }

  const onSeek = (segment: Segment): void => setPlayhead(sourceMsToFrame(segment.startMs))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
          Transcript
        </span>
        <span className="text-[10px] text-ink-600">
          {transcript.language} · {transcript.words.length} words
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {transcript.segments.map((segment) => {
          const active = segment.id === activeId
          return (
            <button
              key={segment.id}
              onClick={() => onSeek(segment)}
              className={`flex w-full gap-2 border-b border-ink-850 px-3 py-1.5 text-left transition-colors ${
                active ? 'bg-flame-500/15' : 'hover:bg-ink-850'
              }`}
            >
              <span
                className={`shrink-0 font-mono text-[10px] tabular-nums ${
                  active ? 'text-flame-400' : 'text-ink-600'
                }`}
              >
                {formatTimecode(sourceMsToFrame(segment.startMs), fps)}
              </span>
              <span className={`text-[11.5px] leading-snug ${active ? 'text-ink-200' : 'text-ink-400'}`}>
                {segment.text}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-ink-600">
      {children}
    </div>
  )
}
