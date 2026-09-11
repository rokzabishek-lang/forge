import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import type { MediaInfo } from '@shared/types'
import { extOf, kindForExt } from '@shared/media'
import { FFPROBE_PATH } from './paths'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  duration?: string
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string }
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null
  const [num, den] = rate.split('/').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  const fps = num / den
  return fps > 0 ? Math.round(fps * 100) / 100 : null
}

function runProbe(path: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_PATH,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message))
        try {
          resolve(JSON.parse(stdout) as FfprobeOutput)
        } catch {
          reject(new Error('ffprobe returned output that could not be parsed'))
        }
      }
    )
  })
}

export async function probeFile(path: string): Promise<MediaInfo> {
  const ext = extOf(path)
  const kindFromExt = kindForExt(ext)
  if (!kindFromExt) throw new Error(`Unsupported file type: .${ext || '(none)'}`)

  const [fileStat, probe] = await Promise.all([stat(path), runProbe(path)])

  const streams = probe.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  const durationSeconds = Number(probe.format?.duration ?? video?.duration ?? audio?.duration)
  const durationMs =
    Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null

  // A still image probes as a single video stream; trust the extension for kind.
  return {
    path,
    name: basename(path),
    size: fileStat.size,
    kind: kindFromExt,
    durationMs: kindFromExt === 'image' ? null : durationMs,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    fps: kindFromExt === 'image' ? null : parseFps(video?.avg_frame_rate)
  }
}

export async function probeMany(
  paths: string[]
): Promise<{ ok: MediaInfo[]; failed: { path: string; error: string }[] }> {
  const results = await Promise.allSettled(paths.map(probeFile))
  const ok: MediaInfo[] = []
  const failed: { path: string; error: string }[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') ok.push(result.value)
    else failed.push({ path: paths[i], error: String(result.reason?.message ?? result.reason) })
  })
  return { ok, failed }
}
