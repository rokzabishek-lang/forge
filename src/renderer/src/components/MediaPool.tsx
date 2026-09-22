import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Captions, FileWarning, Film, Image as ImageIcon, Link2, Loader2, Music, Plus, X } from 'lucide-react'
import type { MediaAsset } from '@shared/timeline'
import { formatDuration, formatBytes } from '@shared/time'
import { framesToSeconds } from '@shared/timeline'
import { useEditor } from '../store'
import { mediaUrl } from '../media'
import { setDragPayload } from '../dragPayload'
import type { DragPayload } from '@shared/dragPayload'

const ICON = { video: Film, audio: Music, image: ImageIcon }

/**
 * What a pool tile carries while being dragged.
 *
 * `assetId` is what separates this from a library drag: the file is already
 * imported and probed, so the drop reuses it rather than reading it again.
 * `mediaKind` rides along because a sound belongs on an audio track and a
 * picture does not, and the payload is all the drop target gets to look at.
 */
function poolPayload(asset: MediaAsset): DragPayload {
  return {
    kind: 'media',
    file: asset.path,
    name: asset.name,
    assetId: asset.id,
    mediaKind: asset.kind
  }
}

/**
 * A frame of the thing, rather than its filename.
 *
 * Video gets a `<video>` seeked a little way in — `#t=0.5` rather than 0,
 * because the first frame of a clip is very often black and a grid of black
 * squares identifies nothing. Audio has no picture to show, so it keeps an
 * icon and leans on its name.
 */
function Thumbnail({ asset }: { asset: MediaAsset }): ReactNode {
  /*
   * A file that is not there says so, rather than showing a broken thumbnail.
   *
   * An `<img>` pointing at a missing file renders as a grey box with a torn
   * icon in it, which reads as the app failing to load a picture — not as the
   * picture having moved.
   */
  if (asset.offline) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1 bg-red-950/40">
        <FileWarning size={18} className="text-red-400" />
        <span className="text-[9px] font-medium uppercase tracking-wide text-red-400">Offline</span>
      </div>
    )
  }
  if (!asset.path || asset.kind === 'audio') {
    const Icon = ICON[asset.kind]
    return (
      <div className="flex size-full items-center justify-center bg-ink-800">
        <Icon size={20} className="text-ink-600" />
      </div>
    )
  }
  const url = mediaUrl(asset.path)
  if (asset.kind === 'video') {
    return (
      <video
        src={`${url}#t=0.5`}
        preload="metadata"
        muted
        playsInline
        className="size-full object-cover"
      />
    )
  }
  return <img src={url} alt="" loading="lazy" className="size-full object-cover" />
}

export function MediaPool(): ReactNode {
  const project = useEditor((s) => s.project)
  const importAssets = useEditor((s) => s.importAssets)
  const relinkMedia = useEditor((s) => s.relinkMedia)
  const addAssetToTimeline = useEditor((s) => s.addAssetToTimeline)
  const transcribeAsset = useEditor((s) => s.transcribeAsset)
  const cancelTranscribe = useEditor((s) => s.cancelTranscribe)
  const transcribing = useEditor((s) => s.transcribing)
  const sidecarReady = useEditor((s) => s.sidecarReady)
  const offline = project.assets.filter((a) => a.offline)
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

      {/*
        One bar for everything that is missing, with one button that fixes all
        of it. A project arrives from another machine with a hundred clips
        offline, and relinking them one at a time is not a feature anyone would
        use — so the folder case is the one the header offers.
      */}
      {offline.length > 0 && (
        <div className="flex items-center gap-2 border-b border-red-900/50 bg-red-950/30 px-3 py-1.5">
          <FileWarning size={13} className="shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-red-200">
            {offline.length} file{offline.length === 1 ? '' : 's'} missing
          </span>
          <button
            onClick={() => void relinkMedia()}
            className="flex shrink-0 items-center gap-1 rounded bg-red-500/20 px-1.5 py-0.5 text-[11px] text-red-200 hover:bg-red-500/30"
          >
            <Link2 size={11} /> Relink…
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {project.assets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-xs text-ink-400">Drop media here</div>
            <div className="text-[11px] text-ink-600">video, audio or images</div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5 p-2">
            {project.assets.map((asset) => {
              const Icon = ICON[asset.kind]
              const job = transcribing[asset.id]
              const hasTranscript = Boolean(project.transcripts[asset.id])
              return (
                <div
                  key={asset.id}
                  draggable
                  onDragStart={(e) => setDragPayload(e, poolPayload(asset))}
                  onDoubleClick={() => addAssetToTimeline(asset.id)}
                  title={`${asset.name}\n${details(asset)}\n\nDrag onto the timeline, or double-click`}
                  className="group relative aspect-square cursor-grab overflow-hidden rounded-md border border-ink-700 bg-ink-850 hover:border-flame-500 active:cursor-grabbing"
                >
                  <Thumbnail asset={asset} />

                  {/*
                    The name, over the picture rather than beside it.

                    A list of filenames is unreadable when the files are
                    IMG_4821 and DSC_0037, which is what a camera gives you —
                    the picture is the only thing that identifies a shot, so it
                    gets the tile and the name gets a caption.
                  */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/95 to-transparent px-1 pb-0.5 pt-3">
                    <div className="truncate text-[9px] leading-tight text-ink-200">{asset.name}</div>
                  </div>

                  <div className="pointer-events-none absolute left-1 top-1 rounded bg-ink-950/75 p-0.5">
                    <Icon size={10} className="text-ink-300" />
                  </div>

                  {asset.kind !== 'image' && (
                    <span className="pointer-events-none absolute right-1 top-1 rounded bg-ink-950/75 px-1 text-[9px] tabular-nums text-ink-300">
                      {formatDuration(framesToSeconds(asset.durationFrames, project.settings.fps))}
                    </span>
                  )}

                  {job ? (
                    <button
                      onClick={() => cancelTranscribe(asset.id)}
                      title={job.message ?? 'Transcribing — click to cancel'}
                      className="absolute inset-x-1 bottom-4 flex items-center justify-center gap-1 rounded bg-flame-500/90 px-1 py-0.5 text-[9px] font-medium text-ink-950"
                    >
                      <Loader2 size={9} className="animate-spin" />
                      {job.progress === null ? 'analysing' : `${Math.round(job.progress * 100)}%`}
                      <X size={8} />
                    </button>
                  ) : (
                    asset.kind !== 'image' && (
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
                        className={`absolute bottom-4 right-1 rounded p-1 transition-opacity disabled:opacity-30 ${
                          hasTranscript
                            ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/50'
                            : 'bg-ink-950/75 text-ink-300 opacity-0 group-hover:opacity-100 hover:text-ink-100'
                        }`}
                      >
                        <Captions size={11} />
                      </button>
                    )
                  )}
                </div>
              )
            })}
          </div>
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
