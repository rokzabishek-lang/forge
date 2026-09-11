import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Captions, Film, Image as ImageIcon, Loader2, Music, Plus, X } from 'lucide-react'
import type { MediaAsset } from '@shared/timeline'
import { formatDuration, formatBytes } from '@shared/time'
import { framesToSeconds } from '@shared/timeline'
import { useEditor } from '../store'

const ICON = { video: Film, audio: Music, image: ImageIcon }

export function MediaPool(): ReactNode {
  const project = useEditor((s) => s.project)
  const importAssets = useEditor((s) => s.importAssets)
  const addAssetToTimeline = useEditor((s) => s.addAssetToTimeline)
  const transcribeAsset = useEditor((s) => s.transcribeAsset)
  const cancelTranscribe = useEditor((s) => s.cancelTranscribe)
  const transcribing = useEditor((s) => s.transcribing)
  const sidecarReady = useEditor((s) => s.sidecarReady)
  const notify = useEditor((s) => s.notify)
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      depth.current = 0
      setOver(false)

      const paths: string[] = []
      for (const file of Array.from(event.dataTransfer.files)) {
        // File.path was removed in Electron 32; webUtils via preload is the
        // supported replacement and returns '' for non-disk items.
        const path = window.forge.getPathForFile(file)
        if (path) paths.push(path)
      }
      if (paths.length === 0) {
        notify('Those items have no file on disk — use Import instead', 'info')
        return
      }
      void importAssets(paths)
    },
    [importAssets, notify]
  )

  const pick = useCallback(async () => {
    const paths = await window.forge.pickMedia()
    await importAssets(paths)
  }, [importAssets])

  const details = (asset: MediaAsset): string => {
    const bits = [formatBytes(asset.size)]
    if (asset.kind !== 'image') {
      bits.push(formatDuration(framesToSeconds(asset.durationFrames, project.settings.fps)))
    }
    if (asset.width && asset.height) bits.push(`${asset.width}×${asset.height}`)
    return bits.join(' · ')
  }

  return (
    <div
      className="relative flex h-full flex-col bg-ink-900"
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current++
        setOver(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault()
        depth.current--
        if (depth.current <= 0) setOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Media</span>
        <button
          onClick={() => void pick()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-ink-200"
        >
          <Plus size={12} /> Import
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {project.assets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-xs text-ink-400">Drop media here</div>
            <div className="text-[11px] text-ink-600">video, audio or images</div>
          </div>
        ) : (
          project.assets.map((asset) => {
            const Icon = ICON[asset.kind]
            return (
              <div
                key={asset.id}
                onDoubleClick={() => addAssetToTimeline(asset.id)}
                title="Double-click to add to the timeline"
                className="group flex cursor-default items-center gap-2.5 border-b border-ink-850 px-3 py-2 hover:bg-ink-850"
              >
                <Icon size={14} className="shrink-0 text-ink-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-ink-200">{asset.name}</div>
                  <div className="truncate text-[10.5px] text-ink-400">{details(asset)}</div>
                </div>
                {(() => {
                  const job = transcribing[asset.id]
                  const hasTranscript = Boolean(project.transcripts[asset.id])
                  if (job) {
                    return (
                      <button
                        onClick={() => cancelTranscribe(asset.id)}
                        title={job.message ?? 'Transcribing — click to cancel'}
                        className="flex shrink-0 items-center gap-1 rounded bg-flame-500/25 px-1.5 py-0.5 text-[10px] font-medium text-flame-300 ring-1 ring-flame-500/60 hover:bg-flame-500/40"
                      >
                        <Loader2 size={10} className="animate-spin" />
                        {job.progress === null ? 'analysing' : `${Math.round(job.progress * 100)}%`}
                        <X size={9} />
                      </button>
                    )
                  }
                  return (
                    <>
                      {asset.kind !== 'image' && (
                        <button
                          onClick={() => void transcribeAsset(asset.id)}
                          disabled={!sidecarReady}
                          title={
                            !sidecarReady
                              ? 'The AI sidecar is not running'
                              : hasTranscript
                                ? 'Transcribed — click to redo'
                                : 'Transcribe'
                          }
                          className={`shrink-0 rounded p-1 transition-opacity hover:bg-ink-700 disabled:opacity-30 ${
                            hasTranscript
                              ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40'
                              : 'text-ink-400 opacity-60 group-hover:opacity-100 hover:text-ink-200'
                          }`}
                        >
                          <Captions size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => addAssetToTimeline(asset.id)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-600 opacity-0 group-hover:opacity-100 hover:bg-ink-700 hover:text-ink-200"
                      >
                        Add
                      </button>
                    </>
                  )
                })()}
              </div>
            )
          })
        )}
      </div>

      {over && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ink-950/85">
          <div className="rounded-lg border-2 border-dashed border-flame-500 px-6 py-4 text-xs text-flame-400">
            Drop to import
          </div>
        </div>
      )}
    </div>
  )
}
