import { describe, it, expect, vi } from 'vitest'
import { separateStems, type SeparateDeps } from '../src/main/separate'
import type { Stems } from '../src/main/stems'

/*
 * The policy, with both dependencies swapped for fakes: ask the sidecar for a
 * real separation, fall back to mid/side when it cannot — and NEVER fall back
 * when the user cancelled. That last rule is the reason this module exists:
 * the inline version swallowed cancellation in its catch and quietly produced
 * the cheap version instead of stopping.
 */

const SEPARATED: Stems = { voice: '/s/v.wav', instrumental: '/s/i.wav', backend: 'demucs/htdemucs', quality: 'separated' }
const EMPHASISED: Stems = { voice: '/m/v.wav', instrumental: '/m/i.wav', backend: 'mid-side', quality: 'emphasised' }

function deps(over: Partial<SeparateDeps> = {}): SeparateDeps & { sidecar: ReturnType<typeof vi.fn>; fallback: ReturnType<typeof vi.fn> } {
  return {
    sidecar: vi.fn(async () => SEPARATED),
    fallback: vi.fn(async () => EMPHASISED),
    ...over
  } as never
}

describe('separateStems', () => {
  it('takes the real separation when the sidecar has it', async () => {
    const d = deps()
    const result = await separateStems('/song.m4a', 'separated', {}, d)
    expect(result).toBe(SEPARATED)
    expect(d.fallback).not.toHaveBeenCalled()
  })

  it('falls back to mid/side when the sidecar cannot, and says so in the result', async () => {
    // demucs not installed is the NORMAL case, not the error case.
    const d = deps({ sidecar: vi.fn(async () => { throw new Error('stems unavailable: demucs is not installed') }) })
    const result = await separateStems('/song.m4a', 'separated', {}, d)
    expect(result.quality).toBe('emphasised')
    expect(d.fallback).toHaveBeenCalledWith('/song.m4a')
  })

  it('never asks the sidecar when the cheap one was requested', async () => {
    const d = deps()
    const result = await separateStems('/song.m4a', 'emphasised', {}, d)
    expect(result).toBe(EMPHASISED)
    expect(d.sidecar).not.toHaveBeenCalled()
  })

  it('does NOT fall back when the user cancelled — it stops', async () => {
    /*
     * The bug. The sidecar rejects when its request is aborted; the old catch
     * treated that like "demucs missing" and ran mid/side anyway. Cancelling a
     * five-minute Demucs job then produced a file and reported success.
     */
    const controller = new AbortController()
    const d = deps({
      sidecar: vi.fn(async (_path, { signal }) => {
        controller.abort()
        void signal
        throw new Error('Cancelled')
      })
    })
    await expect(separateStems('/song.m4a', 'separated', { signal: controller.signal }, d)).rejects.toMatchObject({
      name: 'CancelledError'
    })
    expect(d.fallback).not.toHaveBeenCalled()
  })

  it('refuses immediately if already cancelled, touching nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const d = deps()
    await expect(separateStems('/song.m4a', 'separated', { signal: controller.signal }, d)).rejects.toMatchObject({
      name: 'CancelledError'
    })
    expect(d.sidecar).not.toHaveBeenCalled()
    expect(d.fallback).not.toHaveBeenCalled()
  })

  it('forwards the signal and progress to the sidecar', async () => {
    const controller = new AbortController()
    const onProgress = vi.fn()
    const d = deps({
      sidecar: vi.fn(async (_path, options) => {
        options.onProgress?.(0.5, 'separating')
        return SEPARATED
      })
    })
    await separateStems('/song.m4a', 'separated', { signal: controller.signal, onProgress }, d)
    expect(d.sidecar.mock.calls[0][1].signal).toBe(controller.signal)
    expect(onProgress).toHaveBeenCalledWith(0.5, 'separating')
  })

  it('says which one it is running when it falls back', async () => {
    const onProgress = vi.fn()
    const d = deps({ sidecar: vi.fn(async () => { throw new Error('no demucs') }) })
    await separateStems('/song.m4a', 'separated', { onProgress }, d)
    expect(onProgress).toHaveBeenCalledWith(null, 'separating (mid/side)')
  })
})
