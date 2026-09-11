import { spawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { FFMPEG_PATH } from '../ffmpeg/paths'

export interface CompositeOptions {
  /** Base video the graphics are laid over. */
  videoPath: string
  outputPath: string
  width: number
  height: number
  fps: number
  durationFrames: number
  /** Returns raw BGRA for a frame: width * height * 4 bytes. */
  produceFrame: (frame: number) => Promise<Buffer>
  onProgress?: (progress: number) => void
  /** Override the ffmpeg binary; used by tests. */
  ffmpegPath?: string
  crf?: number
  preset?: string
}

export interface CompositeHandle {
  promise: Promise<void>
  cancel: () => void
}

export class CompositeError extends Error {}

/**
 * Composite a stream of RGBA graphics frames over a video.
 *
 * Frames arrive as raw BGRA on ffmpeg's stdin rather than as PNG files: no
 * encode/decode per frame, no thousands of temp files, and the alpha channel
 * survives untouched. BGRA (not RGBA) is what Electron's `NativeImage.toBitmap()`
 * produces — feeding ffmpeg the wrong order swaps red and blue, which looks like
 * a colour-management bug and is not one.
 */
export function compositeGraphics(options: CompositeOptions): CompositeHandle {
  const {
    videoPath, outputPath, width, height, fps, durationFrames, produceFrame, onProgress
  } = options

  let cancelled = false
  /** ffmpeg has exited; nothing will read further frames. */
  let consumerGone = false
  let child: ChildProcess | null = null

  const promise = new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-f', 'rawvideo',
      '-pixel_format', 'bgra',
      '-video_size', `${width}x${height}`,
      '-framerate', String(fps),
      '-i', 'pipe:0',
      // shortest=1 ends on whichever runs out first, so a graphics stream that
      // is a frame short cannot extend or truncate the picture unexpectedly.
      '-filter_complex', '[0:v][1:v]overlay=0:0:shortest=1,format=yuv420p[v]',
      '-map', '[v]',
      // The base video may have no audio; '?' makes the mapping optional rather
      // than a hard failure.
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-crf', String(options.crf ?? 20),
      '-preset', options.preset ?? 'medium',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath
    ]

    child = spawn(options.ffmpegPath ?? FFMPEG_PATH, args, { windowsHide: true })

    const stderr: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr.push(chunk)
      if (stderr.length > 20) stderr.shift()
    })

    child.on('error', (err) => reject(new CompositeError(`Could not start ffmpeg: ${err.message}`)))

    child.on('close', (code) => {
      // overlay's shortest=1 can end the render before every frame is consumed.
      // Producing more is pure waste — a Chromium frame is expensive.
      consumerGone = true

      if (code === 0 && !cancelled) {
        onProgress?.(1)
        resolve()
        return
      }

      // The partial file must be gone BEFORE the caller is told the render
      // failed. Rejecting first leaves a truncated video on disk that looks
      // like a successful export to anything that checks afterwards.
      const reason = cancelled
        ? new CompositeError('Cancelled')
        : new CompositeError(stderr.join('').trim() || `ffmpeg exited with code ${code}`)

      void unlink(outputPath)
        .catch(() => undefined)
        .then(() => reject(reason))
    })

    const stdin = child.stdin
    if (!stdin) {
      reject(new CompositeError('ffmpeg did not provide a stdin pipe'))
      return
    }
    // EPIPE is expected if ffmpeg exits early; the close handler reports why.
    stdin.on('error', () => undefined)

    const expectedBytes = width * height * 4

    void (async () => {
      try {
        for (let frame = 0; frame < durationFrames; frame++) {
          if (cancelled || consumerGone) break

          const buffer = await produceFrame(frame)
          if (buffer.length !== expectedBytes) {
            throw new CompositeError(
              `Frame ${frame} is ${buffer.length} bytes, expected ${expectedBytes} ` +
                `(${width}x${height} BGRA)`
            )
          }

          if (consumerGone) break

          // Respect backpressure: a 1080x1920 frame is ~8MB, and ignoring the
          // drain signal buffers the entire render in memory. The drain wait
          // also has to end if ffmpeg exits, or it never settles.
          if (!stdin.write(buffer)) {
            await new Promise<void>((resolveDrain) => {
              const done = (): void => {
                stdin.off('drain', done)
                child?.off('close', done)
                resolveDrain()
              }
              stdin.once('drain', done)
              child?.once('close', done)
            })
          }
          onProgress?.((frame + 1) / durationFrames)
        }
        if (!consumerGone) stdin.end()
      } catch (err) {
        cancelled = true
        stdin.destroy()
        child?.kill('SIGKILL')
        reject(err instanceof Error ? err : new CompositeError(String(err)))
      }
    })()
  })

  return {
    promise,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      child?.stdin?.destroy()
      if (process.platform === 'win32' && child?.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
      } else {
        child?.kill('SIGKILL')
      }
    }
  }
}
