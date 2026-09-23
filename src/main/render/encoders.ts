import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG_PATH } from '../ffmpeg/paths'
import { ENCODERS, containerFor, probeArgs, type EncoderId } from '@shared/render/encode'

/**
 * Which encoders actually work on THIS machine.
 *
 * Two questions, and only the second decides anything:
 *
 * 1. **Is it compiled in?** `ffmpeg -encoders` answers that, and it is cheap, so
 *    it is asked first to skip encoders that cannot possibly work.
 * 2. **Does it encode?** Being listed is not evidence. Measured on the bundled
 *    macOS build: `h264_videotoolbox` is listed, and then fails to open a
 *    compression session. A hardware encoder also depends on the GPU, the
 *    driver and the OS — things no build flag knows. So each listed candidate
 *    encodes ten real frames, with exactly the arguments the export will use
 *    (`probeArgs` calls `encoderArgs`), and only a success is offered.
 *
 * This is also the only honest answer to FIX.md's "measure whether the Windows
 * build lists it": the 2018 snapshot is a different binary with different build
 * flags, it cannot be probed from a Mac, and so it probes itself, on the machine
 * it is running on, the first time anyone asks.
 *
 * Cached for the life of the process: a GPU does not appear mid-session, and a
 * probe per export would add a second to every one.
 */

export interface EncoderAvailability {
  id: EncoderId
  ok: boolean
  /** Why not, in ffmpeg's words, when it is not. */
  reason?: string
}

function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG_PATH,
      args,
      // windowsHide: every console-subsystem child without it opens a window
      // in a packaged app (CLAUDE.md). A short timeout: a probe that hangs is
      // an encoder that is not usable, and must not hold up the export panel.
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    )
  })
}

/** Which encoder names the binary lists, from `-encoders`. */
export function listedEncoders(output: string): Set<string> {
  const names = new Set<string>()
  for (const line of output.split('\n')) {
    // " V....D libx264   libx264 H.264 / AVC ..." — flags, then the name. The
    // legend above the list (" V..... = Video") has the same shape up to the
    // name, so a name has to start like one.
    const found = /^\s[VAS][.A-Z]{5}\s+(\w[\w-]*)/.exec(line)
    if (found) names.add(found[1])
  }
  return names
}

let cached: Promise<EncoderAvailability[]> | null = null

export function probeEncoders(): Promise<EncoderAvailability[]> {
  cached ??= probe().catch((err: unknown) => {
    /*
     * A probe that could not run at all — no writable temp folder on a locked
     * profile, a full disk at first launch — is not an answer about the
     * encoders. Cached, it would have hidden every encoder but H.264 until the
     * app restarted; forgotten, the next ask tries again.
     */
    cached = null
    throw err
  })
  return cached
}

async function probe(): Promise<EncoderAvailability[]> {
  const listing = await run(['-hide_banner', '-encoders'])
  const listed = listing.ok ? listedEncoders(listing.stdout) : new Set<string>()
  const dir = await mkdtemp(join(tmpdir(), 'forge-encoders-'))
  try {
    const results: EncoderAvailability[] = []
    // One at a time: hardware sessions are a scarce resource, and two probes
    // contending for one encoder can make both fail.
    for (const { id } of ENCODERS) {
      if (!listed.has(id)) {
        results.push({ id, ok: false, reason: 'not in this build' })
        continue
      }
      const out = join(dir, `${id}.${containerFor(id, 'mp4')}`)
      const attempt = await run(probeArgs(id, out))
      const size = await stat(out).then((s) => s.size, () => 0)
      results.push(
        attempt.ok && size > 0
          ? { id, ok: true }
          : { id, ok: false, reason: attempt.stderr.trim().split('\n').pop() || 'the test encode failed' }
      )
    }
    return results
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
