import { type ReactNode } from 'react'
import { Crop, Grid3x3, MousePointer2, Scan, Brush, Circle, Droplet, Type } from 'lucide-react'
import { solveCrop, useEditor } from '../store'
import { defaultMask, type MaskMode } from '@shared/render/mask'

/**
 * The tool strip, beside the picture.
 *
 * Tools that change what the pointer does, or what is drawn over the frame —
 * distinct from the left panel, which is about what goes ON the timeline. A
 * reframe rectangle was previously reachable only by opening the split view,
 * which is an odd home for it: comparing source against output has nothing to
 * do with choosing a crop.
 *
 * The unbuilt tools are shown greyed and say so when hovered rather than being
 * hidden. A tool strip that grows a new icon every week is harder to learn than
 * one whose shape is visible from the start — but a button that silently does
 * nothing is worse than either, so these are visibly not ready.
 */

interface Tool {
  id: string
  label: string
  hint: string
  icon: typeof Crop
  /** Absent while the tool has nothing behind it yet. */
  onClick?: () => void
  active?: boolean
  soon?: string
  /**
   * Nothing behind it yet — as opposed to merely unavailable right now.
   *
   * Mask and Blur drop their handler when no clip is selected, so "has no
   * onClick" is not the same question as "is not built", and using it to place
   * the divider moved the line in front of two working tools whenever nothing
   * was selected.
   */
  unbuilt?: true
}

export function Toolbox(): ReactNode {
  const previewTool = useEditor((s) => s.previewTool)
  const setPreviewTool = useEditor((s) => s.setPreviewTool)
  const showThirds = useEditor((s) => s.showThirds)
  const showSafe = useEditor((s) => s.showSafe)
  const toggleGuide = useEditor((s) => s.toggleGuide)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const selected = useEditor((s) => s.project.clips.find((c) => c.id === s.selectedClipId) ?? null)
  const setMask = useEditor((s) => s.setMask)
  const addTextClip = useEditor((s) => s.addTextClip)
  const setCrop = useEditor((s) => s.setCrop)
  const aspect = useEditor((s) => s.aspect)
  const assets = useEditor((s) => s.project.assets)
  const playhead = useEditor((s) => s.playhead)
  const tracks = useEditor((s) => s.project.tracks)

  /**
   * Text over the frame, on the topmost video track.
   *
   * `addTextClip` stacks rather than sequences, so it lands ON what is showing
   * rather than after it — and grows a new track when the top one is busy at
   * that moment, which is what makes a second line of text a second layer.
   */
  const addTextHere = async (): Promise<void> => {
    const video = tracks.filter((t) => t.kind === 'video' && !t.locked)
    const top = video[video.length - 1] ?? tracks.find((t) => t.kind === 'video')
    if (top) await addTextClip(top.id, playhead)
  }

  /**
   * Reframe, with something to actually drag.
   *
   * The overlay draws nothing when the clip has no `crop`, and most clips have
   * none: `solveCrop` returns undefined when the source already matches the
   * project's aspect — "no crop needed" — and library assets never get one at
   * all. So pressing Reframe on a 9:16 clip in a 9:16 project did nothing,
   * silently, which is the same failure the Mask button below was written to
   * avoid: pressing a tool must always leave something on screen.
   *
   * A full-frame rectangle is the honest starting point. It changes no pixels
   * until it is dragged.
   */
  const startCrop = (): void => {
    setPreviewTool('crop')
    if (!selectedClipId || !selected || selected.crop) return
    const asset = assets.find((a) => a.id === selected.assetId)
    if (!asset?.width || !asset?.height) return
    setCrop(
      selectedClipId,
      solveCrop(asset, aspect) ?? { x: 0, y: 0, width: asset.width, height: asset.height }
    )
  }

  /*
   * One button both opens the tool and puts a shape on the picture.
   *
   * Reaching for Blur and getting an editing mode but no visible shape is the
   * version of this that reads as broken — so pressing it always leaves
   * something on screen to drag. Pressing it again when that mode is already
   * running takes the mask off, which is the only obvious way back out.
   */
  const startMask = (mode: MaskMode) => (): void => {
    if (!selectedClipId || !selected) return
    if (selected.mask?.mode === mode && previewTool === 'mask') {
      setMask(selectedClipId, undefined)
      setPreviewTool('select')
      return
    }
    setMask(selectedClipId, selected.mask ? { ...selected.mask, mode } : defaultMask(mode))
    setPreviewTool('mask')
  }

  const tools: Tool[] = [
    {
      id: 'select',
      label: 'Select',
      hint: 'Move, scale and rotate on the picture',
      icon: MousePointer2,
      active: previewTool === 'select',
      onClick: () => setPreviewTool('select')
    },
    {
      id: 'crop',
      label: 'Reframe',
      hint: selected
        ? 'Drag the crop rectangle on the picture'
        : 'Select a clip first — a crop belongs to one clip',
      icon: Crop,
      active: previewTool === 'crop',
      onClick: selected ? startCrop : undefined,
      soon: 'select a clip first'
    },
    {
      id: 'thirds',
      label: 'Thirds',
      hint: 'Rule-of-thirds guides',
      icon: Grid3x3,
      active: showThirds,
      onClick: () => toggleGuide('thirds')
    },
    {
      id: 'safe',
      label: 'Safe areas',
      hint: 'Title-safe and action-safe, per SMPTE ST 2046-1',
      icon: Scan,
      active: showSafe,
      onClick: () => toggleGuide('safe')
    },
    {
      /*
       * Text ON the picture, as opposed to text as a thing on the timeline.
       *
       * Both make the same kind of clip — a canvas-sized transparent card that
       * stacks above whatever is under the playhead — so whether it reads as a
       * title card or as a caption over the footage depended entirely on
       * whether something happened to be underneath, and nothing said which
       * you were getting.
       *
       * Where you reach for it is what settles that. This strip acts on the
       * frame you are looking at, so pressing T here plainly means "put words
       * on this picture"; `+ Text` in the left panel adds a text thing to the
       * timeline, which is where a standalone card belongs.
       */
      id: 'text',
      label: 'Text',
      hint: 'Put text on the picture — it lands over whatever is under the playhead',
      icon: Type,
      onClick: () => {
        setPreviewTool('select')
        void addTextHere()
      }
    },
    {
      id: 'mask',
      label: 'Mask',
      hint: selected
        ? 'Show this clip only inside a shape'
        : 'Select a clip first — a mask belongs to one clip',
      icon: Circle,
      active: previewTool === 'mask' && selected?.mask?.mode === 'reveal',
      onClick: selected ? startMask('reveal') : undefined,
      soon: 'select a clip first'
    },
    {
      id: 'blur',
      label: 'Blur',
      hint: selected
        ? 'Blur inside a shape — invert it for a blurred background'
        : 'Select a clip first — a blur belongs to one clip',
      icon: Droplet,
      active: previewTool === 'mask' && selected?.mask?.mode === 'blur',
      onClick: selected ? startMask('blur') : undefined,
      soon: 'select a clip first'
    },
    {
      id: 'paint',
      label: 'Paint',
      hint: 'Painting pixels frame by frame',
      icon: Brush,
      soon: 'stills only, and a long way off',
      unbuilt: true
    }
  ]

  const firstUnbuilt = tools.findIndex((t) => t.unbuilt)

  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center gap-0.5 border-r border-ink-850 bg-ink-900 py-2">
      {tools.map((tool, index) => {
        const Icon = tool.icon
        const ready = tool.onClick !== undefined
        return (
          <div key={tool.id} className="contents">
            {/*
              A rule between what is built and what is not.

              This was a hard-coded `index === 6`, and adding Text in the
              middle of the list silently slid it in front of Blur. Deriving it
              from "has no handler" was no better: Mask and Blur drop theirs
              when nothing is selected, so the line moved as you clicked
              around. The tool says so itself instead.
            */}
            {index === firstUnbuilt && <div className="my-1 h-px w-5 bg-ink-800" />}
            <button
              onClick={tool.onClick}
              disabled={!ready}
              title={ready ? `${tool.label} — ${tool.hint}` : `${tool.label} — ${tool.soon}`}
              className={`flex size-7 items-center justify-center rounded-md transition-colors ${
                tool.active
                  ? 'bg-flame-500 text-ink-950'
                  : ready
                    ? 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'
                    : 'cursor-not-allowed text-ink-700'
              }`}
            >
              <Icon size={14} strokeWidth={1.8} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
