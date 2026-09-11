import type { BuildContext, MediaKind, ParamValues, Preset } from './types'
import { parseTime } from './time'

const VIDEO_IN = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp']
const AUDIO_IN = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'opus', 'wma', 'aiff']
const IMAGE_IN = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tiff', 'tif', 'gif', 'bmp', 'heic']

const str = (p: ParamValues, k: string): string => String(p[k] ?? '')
const num = (p: ParamValues, k: string): number => Number(p[k] ?? 0)
const bool = (p: ParamValues, k: string): boolean => Boolean(p[k])

const SPEED_OPTIONS = [
  { value: 'veryfast', label: 'Very fast (larger file)' },
  { value: 'fast', label: 'Fast' },
  { value: 'medium', label: 'Medium' },
  { value: 'slow', label: 'Slow (smaller file)' },
  { value: 'veryslow', label: 'Very slow (smallest)' }
]

/** Audio output args shared by the video presets. */
function audioArgs(mode: string): string[] {
  if (mode === 'none') return ['-an']
  if (mode === 'copy') return ['-c:a', 'copy']
  return ['-c:a', 'aac', '-b:a', `${mode}k`]
}

const AUDIO_MODE_OPTIONS = [
  { value: '128', label: 'AAC 128 kbps' },
  { value: '192', label: 'AAC 192 kbps' },
  { value: '256', label: 'AAC 256 kbps' },
  { value: 'copy', label: 'Keep original' },
  { value: 'none', label: 'Remove audio' }
]

/** scale filter that preserves aspect and keeps dimensions even (H.264 requires it). */
function scaleFilter(height: number): string {
  return `scale=-2:${height}`
}

export const PRESETS: Preset[] = [
  {
    id: 'video-mp4',
    label: 'Convert to MP4',
    description: 'H.264 video + AAC audio. The format that plays everywhere.',
    kind: 'video',
    engine: 'ffmpeg',
    accepts: VIDEO_IN,
    suffix: '',
    outExt: () => 'mp4',
    params: [
      {
        key: 'crf',
        label: 'Quality',
        type: 'range',
        min: 16,
        max: 32,
        step: 1,
        default: 23,
        ends: ['Best quality', 'Smallest file'],
        help: 'Lower is better quality and a bigger file. 23 is a good default.'
      },
      { key: 'speed', label: 'Encode speed', type: 'select', options: SPEED_OPTIONS, default: 'medium' },
      { key: 'audio', label: 'Audio', type: 'select', options: AUDIO_MODE_OPTIONS, default: '192' }
    ],
    buildArgs: ({ input, output, params }: BuildContext) => [
      '-i', input,
      '-c:v', 'libx264',
      '-crf', String(num(params, 'crf')),
      '-preset', str(params, 'speed'),
      '-pix_fmt', 'yuv420p',
      ...audioArgs(str(params, 'audio')),
      '-movflags', '+faststart',
      output
    ]
  },

  {
    id: 'video-compress',
    label: 'Compress video',
    description: 'Shrink the file, optionally scaling it down at the same time.',
    kind: 'video',
    engine: 'ffmpeg',
    accepts: VIDEO_IN,
    suffix: '-compressed',
    outExt: () => 'mp4',
    params: [
      {
        key: 'crf',
        label: 'Compression',
        type: 'range',
        min: 20,
        max: 34,
        step: 1,
        default: 28,
        ends: ['Gentle', 'Aggressive'],
        help: 'Higher squeezes harder. Past 30 the quality loss starts to show.'
      },
      {
        key: 'scale',
        label: 'Scale down',
        type: 'select',
        options: [
          { value: 'none', label: "Don't resize" },
          { value: '1080', label: 'to 1080p' },
          { value: '720', label: 'to 720p' },
          { value: '480', label: 'to 480p' }
        ],
        default: 'none'
      },
      { key: 'speed', label: 'Encode speed', type: 'select', options: SPEED_OPTIONS, default: 'medium' }
    ],
    buildArgs: ({ input, output, params }: BuildContext) => {
      const scale = str(params, 'scale')
      return [
        '-i', input,
        ...(scale === 'none' ? [] : ['-vf', scaleFilter(Number(scale))]),
        '-c:v', 'libx264',
        '-crf', String(num(params, 'crf')),
        '-preset', str(params, 'speed'),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        output
      ]
    }
  },

  {
    id: 'video-resize',
    label: 'Resize video',
    description: 'Scale to a standard height, keeping the aspect ratio.',
    kind: 'video',
    engine: 'ffmpeg',
    accepts: VIDEO_IN,
    suffix: '-resized',
    outExt: () => 'mp4',
    params: [
      {
        key: 'height',
        label: 'Target height',
        type: 'select',
        options: [
          { value: '2160', label: '2160p (4K)' },
          { value: '1440', label: '1440p' },
          { value: '1080', label: '1080p' },
          { value: '720', label: '720p' },
          { value: '480', label: '480p' },
          { value: '360', label: '360p' }
        ],
        default: '1080'
      },
      { key: 'crf', label: 'Quality', type: 'range', min: 16, max: 30, step: 1, default: 20, ends: ['Best quality', 'Smaller file'] },
      { key: 'speed', label: 'Encode speed', type: 'select', options: SPEED_OPTIONS, default: 'medium' }
    ],
    buildArgs: ({ input, output, params }: BuildContext) => [
      '-i', input,
      '-vf', scaleFilter(num(params, 'height')),
      '-c:v', 'libx264',
      '-crf', String(num(params, 'crf')),
      '-preset', str(params, 'speed'),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      output
    ]
  },

  {
    id: 'video-trim',
    label: 'Trim video',
    description: 'Cut out a section. Leave the end blank to run to the finish.',
    kind: 'video',
    engine: 'ffmpeg',
    accepts: VIDEO_IN,
    suffix: '-trimmed',
    outExt: (params) => (bool(params, 'reencode') ? 'mp4' : 'keep'),
    params: [
      { key: 'start', label: 'Start', type: 'text', default: '0:00', placeholder: '0:00' },
      { key: 'end', label: 'End', type: 'text', default: '', placeholder: 'end of file' },
      {
        key: 'reencode',
        label: 'Re-encode for frame-accurate cuts',
        type: 'toggle',
        default: false,
        help: 'Off is near-instant but snaps to the nearest keyframe. On is exact but slow.'
      }
    ],
    buildArgs: ({ input, output, params }: BuildContext) => {
      const start = parseTime(str(params, 'start')) ?? 0
      const end = parseTime(str(params, 'end'))
      // -t (duration) rather than -to: unambiguous when -ss precedes -i.
      const duration = end !== null && end > start ? end - start : null
      const codec = bool(params, 'reencode')
        ? ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
        : ['-c', 'copy']
      return [
        ...(start > 0 ? ['-ss', String(start)] : []),
        '-i', input,
        ...(duration !== null ? ['-t', String(duration)] : []),
        ...codec,
        output
      ]
    }
  },

  {
    id: 'video-extract-audio',
    label: 'Extract audio',
    description: 'Pull the soundtrack out of a video.',
    kind: 'video',
    engine: 'ffmpeg',
    accepts: VIDEO_IN,
    suffix: '',
    outExt: (params) => str(params, 'format') || 'mp3',
    params: [
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'mp3', label: 'MP3' },
          { value: 'm4a', label: 'AAC (m4a)' },
          { value: 'wav', label: 'WAV (uncompressed)' },
          { value: 'flac', label: 'FLAC (lossless)' }
        ],
        default: 'mp3'
      },
      {
        key: 'bitrate',
        label: 'Bitrate',
        type: 'select',
        options: [
          { value: '128', label: '128 kbps' },
          { value: '192', label: '192 kbps' },
          { value: '256', label: '256 kbps' },
          { value: '320', label: '320 kbps' }
        ],
        default: '192',
        help: 'Ignored for WAV and FLAC, which are not bitrate-based.'
      }
    ],
    buildArgs: ({ input, output, params }: BuildContext) => {
      const format = str(params, 'format')
      const bitrate = str(params, 'bitrate')
      const codec: Record<string, string[]> = {
        mp3: ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`],
        m4a: ['-c:a', 'aac', '-b:a', `${bitrate}k`],
        wav: ['-c:a', 'pcm_s16le'],
        flac: ['-c:a', 'flac']
      }
      return ['-i', input, '-vn', ...(codec[format] ?? codec.mp3), output]
    }
  },

  {
    id: 'video-gif',
    label: 'Export GIF',
    description: 'Turn a clip into an animated GIF with an optimised palette.',
    kind: 'video',
    engine: 'ffmpeg',
    accepts: VIDEO_IN,
    suffix: '',
    outExt: () => 'gif',
    params: [
      { key: 'fps', label: 'Frame rate', type: 'range', min: 5, max: 24, step: 1, default: 12, ends: ['Choppy, small', 'Smooth, large'] },
      {
        key: 'width',
        label: 'Width',
        type: 'select',
        options: [
          { value: '320', label: '320 px' },
          { value: '480', label: '480 px' },
          { value: '640', label: '640 px' },
          { value: '800', label: '800 px' }
        ],
        default: '480'
      },
      { key: 'start', label: 'Start', type: 'text', default: '0:00', placeholder: '0:00' },
      { key: 'end', label: 'End', type: 'text', default: '', placeholder: 'end of file' }
    ],
    buildArgs: ({ input, output, params }: BuildContext) => {
      const start = parseTime(str(params, 'start')) ?? 0
      const end = parseTime(str(params, 'end'))
      const duration = end !== null && end > start ? end - start : null
      const fps = num(params, 'fps')
      const width = num(params, 'width')
      const filter =
        `fps=${fps},scale=${width}:-1:flags=lanczos,` +
        `split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`
      return [
        ...(start > 0 ? ['-ss', String(start)] : []),
        '-i', input,
        ...(duration !== null ? ['-t', String(duration)] : []),
        '-vf', filter,
        '-loop', '0',
        output
      ]
    }
  }
]

export const PRESETS_BY_ID: Record<string, Preset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p])
)

export function defaultParams(preset: Preset): ParamValues {
  return Object.fromEntries(preset.params.map((p) => [p.key, p.default]))
}

/** Extension (no dot, lowercase) for a path. */
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

export function kindForExt(ext: string): MediaKind | null {
  if (VIDEO_IN.includes(ext)) return 'video'
  if (AUDIO_IN.includes(ext)) return 'audio'
  if (IMAGE_IN.includes(ext)) return 'image'
  return null
}

export function presetsFor(kind: MediaKind): Preset[] {
  return PRESETS.filter((p) => p.kind === kind)
}

export const SUPPORTED_EXTENSIONS = { video: VIDEO_IN, audio: AUDIO_IN, image: IMAGE_IN }
