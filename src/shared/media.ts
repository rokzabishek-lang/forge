import type { MediaKind } from './types'

export const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp']
export const AUDIO_EXT = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'opus', 'wma', 'aiff']
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tiff', 'tif', 'gif', 'bmp', 'heic']

export const SUPPORTED_EXTENSIONS = { video: VIDEO_EXT, audio: AUDIO_EXT, image: IMAGE_EXT }
export const ALL_EXTENSIONS = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]

/** Extension without the dot, lowercased. */
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

export function kindForExt(ext: string): MediaKind | null {
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  if (IMAGE_EXT.includes(ext)) return 'image'
  return null
}

export function kindForPath(path: string): MediaKind | null {
  return kindForExt(extOf(path))
}
