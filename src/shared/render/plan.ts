import type { Project, Clip, MediaAsset, Track } from '../timeline'
import { assetById, clipsOnTrack, clipEnd, framesToSeconds, projectDuration } from '../timeline'
import { escapeFilterPath } from '../captions/timeline'
import { transitionById } from '../transitions/registry'

/**
 * Compiles a Timeline IR into an ffmpeg invocation.
 *
 * Pure: no fs, no spawn, no electron. Everything here is unit-testable by
 * asserting on the argv, which matters because a wrong filter graph is otherwise
 * only discoverable by rendering and watching the result.
 *
 * Composition strategy: every clip is laid onto a generated base canvas at its
 * own timeline offset, rather than concatenated. Concat is cheaper for a single
 * contiguous track but cannot express gaps, overlaps or layering — and all three
 * are ordinary once there is more than one track. One mechanism handles the lot.
 */

export interface RenderRequest {
  project: Project
  outputPath: string
  /** Overrides the project canvas, e.g. to render a 9:16 version of a 16:9 edit. */
  canvas?: { width: number; height: number }
  /** Burned-in captions: an .ass file written before the render starts. */
  subtitlesPath?: string
  /** Directory libass searches for the fonts a style names. */
  fontsDir?: string
  crf?: number
  preset?: string
}

export interface RenderPlan {
  args: string[]
  durationFrames: number
  clips: { clip: Clip; asset: MediaAsset; inputIndex: number }[]
}

export class RenderError extends Error {}

/** Even dimensions — H.264 chroma subsampling requires it. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

function fitFilter(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
  )
}

function cropFilter(clip: Clip): string | null {
  const crop = clip.crop
  if (!crop) return null
  return `crop=${even(crop.width)}:${even(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)}`
}

const seconds = (frames: number, fps: number): string => framesToSeconds(frames, fps).toFixed(6)

export function buildRenderPlan(request: RenderRequest): RenderPlan {
  const { project, outputPath } = request
  const canvas = request.canvas ?? { width: project.settings.width, height: project.settings.height }
  const width = even(canvas.width)
  const height = even(canvas.height)
  const fps = project.settings.fps

  const videoTracks = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  if (videoTracks.length === 0) throw new RenderError('The project has no visible video track')

  const totalFrames = projectDuration(project)
  if (totalFrames <= 0) throw new RenderError('The timeline has no clips to render')

  // Tracks composite bottom-up: index 0 is the backmost layer.
  const videoClips: { clip: Clip; track: Track }[] = []
  for (const track of videoTracks) {
    for (const clip of clipsOnTrack(project, track.id)) videoClips.push({ clip, track })
  }
  if (videoClips.length === 0) throw new RenderError('The timeline has no clips to render')

  const audioTracks = project.tracks.filter((t) => t.kind === 'audio' && !t.muted)
  const audioClips = audioTracks.flatMap((t) => clipsOnTrack(project, t.id))

  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
  const filters: string[] = []
  const entries: RenderPlan['clips'] = []

  /* ------------------------------------------------------------- inputs */

  let inputIndex = 0
  const videoInputs: { clip: Clip; index: number; hasAudio: boolean }[] = []

  for (const { clip } of videoClips) {
    const asset = assetById(project, clip.assetId)
    if (!asset) throw new RenderError(`Clip ${clip.id} refers to a missing asset`)

    if (asset.kind === 'image') {
      // A still needs an explicit length or it produces a single frame.
      args.push('-loop', '1', '-t', seconds(clip.duration, fps), '-i', asset.path)
    } else {
      // -ss before -i seeks on the input, far faster on long sources.
      args.push('-ss', seconds(clip.inPoint, fps), '-t', seconds(clip.duration, fps), '-i', asset.path)
    }
    videoInputs.push({ clip, index: inputIndex, hasAudio: asset.hasAudio })
    entries.push({ clip, asset, inputIndex })
    inputIndex++
  }

  const audioInputs: { clip: Clip; index: number }[] = []
  for (const clip of audioClips) {
    const asset = assetById(project, clip.assetId)
    if (!asset) throw new RenderError(`Clip ${clip.id} refers to a missing asset`)
    if (!asset.hasAudio) continue
    args.push('-ss', seconds(clip.inPoint, fps), '-t', seconds(clip.duration, fps), '-i', asset.path)
    audioInputs.push({ clip, index: inputIndex })
    inputIndex++
  }

  /* -------------------------------------------------------------- video */

  // A generated canvas is the bottom layer, so a timeline with gaps renders
  // black rather than stalling or shifting later clips earlier.
  filters.push(
    `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds(totalFrames, fps)},format=yuv420p[base]`
  )

  let current = '[base]'
  videoInputs.forEach(({ clip }, i) => {
    const transition = clip.transitionIn ? transitionById(clip.transitionIn.id) : null
    const transitionSeconds = clip.transitionIn
      ? framesToSeconds(clip.transitionIn.durationFrames, fps)
      : 0
    const context = { duration: transitionSeconds, canvasWidth: width, canvasHeight: height }

    const steps = [
      cropFilter(clip),
      fitFilter(width, height),
      `fps=${fps}`,
      'setsar=1',
      'format=rgba',
      // Transition effects run before setpts, so their times are relative to
      // the clip's own start rather than the timeline's.
      ...(transition?.incoming ? transition.incoming(context) : [])
    ]
      .filter((s): s is string => s !== null)
      .join(',')

    // setpts moves the clip to its timeline position; without it every clip
    // would start at zero regardless of where it sits.
    const offset = seconds(clip.start, fps)
    filters.push(`[${videoInputs[i].index}:v]${steps},setpts=PTS-STARTPTS+${offset}/TB[v${i}]`)

    const start = framesToSeconds(clip.start, fps).toFixed(6)
    const end = framesToSeconds(clipEnd(clip), fps).toFixed(6)
    const next = i === videoInputs.length - 1 ? '[vmix]' : `[o${i}]`

    // Position expressions are written against S, the clip's timeline start.
    const place = transition?.position
      ? (() => {
          const p = transition.position(context)
          return {
            x: p.x.replace(/\bS\b/g, start),
            y: p.y.replace(/\bS\b/g, start)
          }
        })()
      : { x: '0', y: '0' }

    // repeatlast=0 stops the clip's final frame being held for the rest of the
    // timeline; eof_action=pass keeps the base flowing once the clip ends.
    filters.push(
      `${current}[v${i}]overlay=x='${place.x}':y='${place.y}':` +
        `eof_action=pass:repeatlast=0:enable='between(t,${start},${end})'${next}`
    )
    current = next
  })

  let videoOut = '[vmix]'
  if (request.subtitlesPath) {
    const file = escapeFilterPath(request.subtitlesPath)
    const fonts = request.fontsDir ? `:fontsdir=${escapeFilterPath(request.fontsDir)}` : ''
    filters.push(`[vmix]subtitles=filename=${file}${fonts}[vsub]`)
    videoOut = '[vsub]'
  }
  filters.push(`${videoOut}format=yuv420p[vout]`)

  /* -------------------------------------------------------------- audio */

  const audioLabels: string[] = []
  const addAudio = (index: number, clip: Clip, label: string): void => {
    const volume = clip.volume ?? 1
    const delayMs = Math.round(framesToSeconds(clip.start, fps) * 1000)
    const chain = [
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `aresample=${project.settings.sampleRate}`,
      volume === 1 ? null : `volume=${volume}`,
      delayMs > 0 ? `adelay=${delayMs}:all=1` : null
    ]
      .filter((x): x is string => x !== null)
      .join(',')
    filters.push(`[${index}:a]${chain}${label}`)
    audioLabels.push(label)
  }

  videoInputs.forEach(({ clip, index, hasAudio }, i) => {
    if (hasAudio) addAudio(index, clip, `[va${i}]`)
  })
  audioInputs.forEach(({ clip, index }, i) => addAudio(index, clip, `[aa${i}]`))

  if (audioLabels.length === 0) {
    // Silence keeps the output shape identical whether or not anything has
    // audio, so downstream tools never see a video-only file by surprise.
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=${project.settings.sampleRate}:` +
        `d=${seconds(totalFrames, fps)}[aout]`
    )
  } else if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}anull[aout]`)
  } else {
    // normalize=0 stops amix quietly dividing every level by the input count.
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`)
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    // The graph's own duration is authoritative; without this a held audio
    // stream can run past the picture.
    '-t', seconds(totalFrames, fps),
    '-c:v', 'libx264',
    '-crf', String(request.crf ?? 20),
    '-preset', request.preset ?? 'medium',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath
  )

  return { args, durationFrames: totalFrames, clips: entries }
}
