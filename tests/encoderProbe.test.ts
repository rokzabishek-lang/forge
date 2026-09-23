import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * A probe that could not RUN is not an answer about the encoders.
 *
 * `probeEncoders` caches its promise for the life of the process — a GPU does
 * not appear mid-session. It also cached a rejection: one failure to make a
 * temp folder at first launch (a locked profile, a full disk) and every encoder
 * but H.264 was gone until the app restarted. Found by the B2 review.
 *
 * ffmpeg and the file system are faked, because what is under test is the
 * caching, not the encoders.
 */

const fs = vi.hoisted(() => ({ mkdtemp: vi.fn(), made: 0 }))

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdtemp: fs.mkdtemp,
  rm: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 1024 }))
}))
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _opts: unknown, done: (e: null, out: string, err: string) => void) =>
    done(null, args.includes('-encoders') ? ' V....D libx264              H.264\n' : '', '')
}))

beforeEach(() => {
  vi.resetModules()
  fs.mkdtemp.mockReset()
})

describe('the encoder probe', () => {
  it('asks again after a probe that could not run, instead of caching the failure', async () => {
    fs.mkdtemp.mockRejectedValueOnce(new Error('EACCES: permission denied, mkdtemp'))
    fs.mkdtemp.mockResolvedValue('/tmp/forge-encoders-x')
    const { probeEncoders } = await import('../src/main/render/encoders')

    await expect(probeEncoders()).rejects.toThrow(/EACCES/)
    const second = await probeEncoders()
    expect(second.find((e) => e.id === 'libx264')?.ok).toBe(true)
    expect(fs.mkdtemp).toHaveBeenCalledTimes(2)
  })

  it('still asks only once when the probe answered', async () => {
    fs.mkdtemp.mockResolvedValue('/tmp/forge-encoders-x')
    const { probeEncoders } = await import('../src/main/render/encoders')
    await probeEncoders()
    await probeEncoders()
    await probeEncoders()
    expect(fs.mkdtemp).toHaveBeenCalledTimes(1)
  })
})
