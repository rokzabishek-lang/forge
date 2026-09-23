import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { formatTimecode, secondsToFrames } from '@shared/timeline'
import type { Segment, Transcript, Word } from '@shared/transcript'
import { useEditor } from '../store'

/**
 * Transcript for the selected clip's asset, with click-to-seek — and, in Edit,
 * click-to-correct (FIX.md B3).
 *
 * Segment times are milliseconds into the SOURCE, so mapping one to the timeline
 * has to go through the clip's in-point — a segment at 10s of source is not at
 * 10s of timeline unless the clip is untrimmed and starts at zero.
 *
 * A corrected word keeps its timing and the captions read the transcript live,
 * so a misheard name is fixed once, here, and is right in every caption of the
 * preview and the export. The vocabulary below is what stops it being misheard
 * next time: names spelled for the model before it listens.
 */
export function TranscriptPanel(): ReactNode {
  const project = useEditor((s) => s.project)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const playhead = useEditor((s) => s.playhead)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const editTranscriptWord = useEditor((s) => s.editTranscriptWord)
  const [editing, setEditing] = useState(false)

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

  const onSeek = (segment: Segment): void => setPlayhead(sourceMsToFrame(segment.startMs))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
          Transcript
        </span>
        {transcript && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-600">
              {transcript.language} · {transcript.words.length} words
            </span>
            <button
              onClick={() => setEditing((on) => !on)}
              title={editing ? 'Stop correcting' : 'Correct a misheard word: click it, type, Enter'}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                editing ? 'bg-flame-500 font-medium text-ink-950' : 'text-ink-500 hover:bg-ink-800 hover:text-ink-200'
              }`}
            >
              <Pencil size={10} />
              {editing ? 'Done' : 'Edit'}
            </button>
          </div>
        )}
      </div>

      {transcript ? (
        <div className="flex-1 overflow-y-auto">
          {editing && (
            <p className="border-b border-ink-850 px-3 py-1.5 text-[10px] leading-snug text-ink-600">
              Click a word to correct it — Enter keeps it, Esc leaves it, and an empty word is taken
              out. Its timing stays, and the captions follow.
            </p>
          )}
          {transcript.segments.map((segment) => {
            const active = segment.id === activeId
            return editing ? (
              <EditableSegment
                key={segment.id}
                transcript={transcript}
                segment={segment}
                timecode={formatTimecode(sourceMsToFrame(segment.startMs), fps)}
                onEdit={(index, text) => editTranscriptWord(clip.assetId, index, text)}
              />
            ) : (
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
      ) : (
        <Empty>No transcript yet — transcribe it below, or with the caption button in Media</Empty>
      )}

      <Vocabulary assetId={clip.assetId} hasTranscript={Boolean(transcript)} />
    </div>
  )
}

/** One segment, its words each clickable to correct. */
function EditableSegment({
  transcript,
  segment,
  timecode,
  onEdit
}: {
  transcript: Transcript
  segment: Segment
  timecode: string
  onEdit: (index: number, text: string) => void
}): ReactNode {
  const words = transcript.words.filter((w) => w.index >= segment.wordStart && w.index <= segment.wordEnd)
  return (
    <div className="flex gap-2 border-b border-ink-850 px-3 py-1.5">
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-600">{timecode}</span>
      <span className="flex flex-wrap gap-x-1 gap-y-0.5 text-[11.5px] leading-snug text-ink-300">
        {words.map((word) => (
          <EditableWord key={word.index} word={word} onEdit={(text) => onEdit(word.index, text)} />
        ))}
      </span>
    </div>
  )
}

function EditableWord({ word, onEdit }: { word: Word; onEdit: (text: string) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(word.text)
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (open) input.current?.select()
  }, [open])

  if (!open) {
    // A word the model was unsure of says so: it is the likeliest to be wrong.
    const unsure = word.confidence !== null && word.confidence < 0.5
    return (
      <button
        onClick={() => {
          setDraft(word.text)
          setOpen(true)
        }}
        title={unsure ? 'The transcriber was unsure of this word' : 'Click to correct'}
        className={`rounded px-0.5 hover:bg-ink-800 hover:text-ink-100 ${unsure ? 'underline decoration-flame-500/60 decoration-dotted underline-offset-2' : ''}`}
      >
        {word.text}
      </button>
    )
  }
  const commit = (): void => {
    setOpen(false)
    if (draft !== word.text) onEdit(draft)
  }
  return (
    <input
      ref={input}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // Kept from the shortcut layer: these keys belong to the text box now.
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setOpen(false)
      }}
      size={Math.max(3, draft.length + 1)}
      className="rounded bg-ink-800 px-1 text-[11.5px] text-ink-100 outline-none ring-1 ring-flame-500/60"
    />
  )
}

/**
 * The names and words the transcriber listens for.
 *
 * Saved on leaving the field rather than on every keystroke, so typing a list
 * of names is one undo step, not forty. Transcribing again replaces the words,
 * corrections included — the button says so.
 */
function Vocabulary({ assetId, hasTranscript }: { assetId: string; hasTranscript: boolean }): ReactNode {
  const vocabulary = useEditor((s) => s.project.vocabulary ?? '')
  const setVocabulary = useEditor((s) => s.setVocabulary)
  const transcribeAsset = useEditor((s) => s.transcribeAsset)
  const busy = useEditor((s) => Boolean(s.transcribing[assetId]))
  const [draft, setDraft] = useState(vocabulary)
  useEffect(() => setDraft(vocabulary), [vocabulary])

  return (
    <div className="space-y-1 border-t border-ink-800 px-3 py-2">
      <label className="block text-[10px] text-ink-500" htmlFor="forge-vocabulary">
        Listen for — names and words, separated by commas
      </label>
      <textarea
        id="forge-vocabulary"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setVocabulary(draft)}
        onKeyDown={(e) => e.stopPropagation()}
        rows={2}
        placeholder="Priya, Arjun, Taj Falaknuma, Syncpod"
        className="w-full resize-none rounded bg-ink-850 px-2 py-1 text-[11px] text-ink-200 outline-none placeholder:text-ink-700 focus:ring-1 focus:ring-ink-600"
      />
      <button
        onClick={() => {
          setVocabulary(draft)
          void transcribeAsset(assetId)
        }}
        disabled={busy}
        title={hasTranscript ? 'Transcribe this clip again with these words — corrections made here are replaced' : 'Transcribe this clip, listening for these words'}
        className="w-full rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-300 transition-colors hover:bg-ink-700 hover:text-ink-100 disabled:opacity-40"
      >
        {busy ? 'Transcribing…' : hasTranscript ? 'Transcribe again with these words' : 'Transcribe'}
      </button>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-ink-600">
      {children}
    </div>
  )
}
