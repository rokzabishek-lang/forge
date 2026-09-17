import { getSidecar } from './sidecar/service'
import { SIDECAR_METHODS } from '@shared/sidecar/protocol'
import { splitStems, type StemQuality, type Stems } from './stems'
import { CancelledError } from './ffmpeg/run'

/**
 * Ask for the good separation, take the cheap one.
 *
 * Demucs is a real separation and minutes of CPU; mid/side is arithmetic and
 * instant. Most installs will not have demucs at all — it is not in
 * requirements.txt — so the fallback is the normal path rather than the error
 * path, and it is not worth a message on screen. What IS worth reporting is
 * which one answered, which the result carries as `quality`.
 *
 * This used to live inline in the `audio:stems` handler, with one bug: its
 * `catch` swallowed EVERY sidecar error, including the user pressing cancel,
 * and fell back to mid/side. So cancelling a Demucs split did not stop the
 * work — it quietly produced the cheap version and called that done. Two
 * callers want the policy now (the handler and the download job), and neither
 * wants that behaviour, so it lives here with cancellation handled first.
 */

export interface SeparateOptions {
  signal?: AbortSignal
  onProgress?: (progress: number | null, message?: string) => void
}

/** The two things this depends on, injectable so the policy can be tested. */
export interface SeparateDeps {
  sidecar: (path: string, options: SeparateOptions) => Promise<Stems>
  fallback: (path: string) => Promise<Stems>
}

const DEMUCS_TIMEOUT_MS = 900_000

const live: SeparateDeps = {
  sidecar: (path, { signal, onProgress }) =>
    getSidecar().request<Stems>(
      SIDECAR_METHODS.stems,
      { path },
      { signal, timeoutMs: DEMUCS_TIMEOUT_MS, onProgress }
    ),
  fallback: splitStems
}

export async function separateStems(
  path: string,
  quality: StemQuality,
  options: SeparateOptions = {},
  deps: SeparateDeps = live
): Promise<Stems> {
  if (options.signal?.aborted) throw new CancelledError()

  if (quality === 'separated') {
    try {
      return await deps.sidecar(path, options)
    } catch (err) {
      // Cancellation is the user's decision, not a reason to try harder.
      // Checked on the signal rather than on the error's shape, so it holds
      // whatever the transport chooses to reject with.
      if (options.signal?.aborted) throw new CancelledError()
      if (err instanceof Error && err.name === 'CancelledError') throw err
      console.warn('Falling back to mid/side stems', err)
    }
  }

  options.onProgress?.(null, 'separating (mid/side)')
  const stems = await deps.fallback(path)
  if (options.signal?.aborted) throw new CancelledError()
  return stems
}
