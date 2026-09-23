import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { FFMPEG, run } from './output'

/*
 * TEMPORARY — a measurement, not a guard. Delete once it has answered.
 *
 * FIX.md B3's stabiliser: `vidstab` (two passes) is far better than
 * `deshake` — measured on the macOS build over a jittered clip, the marker's
 * spread went 7.6/6.0 px → deshake 4.1/4.1 → vidstab (smoothing 30)
 * 0.5/0.6 — but whether the 2018 Windows build carries libvidstab cannot be
 * measured from a Mac. This runs on the Windows runner only and FAILS ON
 * PURPOSE with what it found, because a failure's message is what CI shows.
 */

const onWindows = process.platform === 'win32'

async function tryRun(args: string[], cwd?: string): Promise<string> {
  try {
    await run(FFMPEG, args, { maxBuffer: 1 << 26, cwd })
    return 'ok'
  } catch (e) {
    return `FAILED ${String(e).split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 160)}`
  }
}

describe.runIf(onWindows)('which stabiliser the 2018 build has', () => {
  it('reports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-steady-'))
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters'], { maxBuffer: 1 << 22 })
    const listed = ['deshake', 'vidstabdetect', 'vidstabtransform'].map((f) => `${f}=${new RegExp(`\\s${f}\\s`).test(String(stdout))}`)
    const shaky = join(dir, 'shaky.mp4')
    const made = await tryRun(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x606060:s=720x420:d=2',
      '-vf', "noise=alls=90:allf=u,drawbox=x=340:y=190:w=40:h=40:color=white:t=fill,crop=640:360:'40+10*sin(n*0.35)':'30+8*cos(n*0.27)',format=yuv420p",
      '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', shaky])
    // cwd = dir and a bare file name: no drive-letter colon for the filter to trip on.
    const detect = await tryRun(['-hide_banner', '-loglevel', 'error', '-y', '-i', 'shaky.mp4', '-vf', 'vidstabdetect=result=t.trf', '-f', 'null', '-'], dir)
    const transform = await tryRun(['-hide_banner', '-loglevel', 'error', '-y', '-i', 'shaky.mp4', '-vf', 'vidstabtransform=input=t.trf:smoothing=30', '-f', 'null', '-'], dir)
    const trf = await readFile(join(dir, 't.trf'), 'utf8').then((t) => `trf ${t.length} bytes, first line "${t.split('\n')[0].slice(0, 40)}"`).catch(() => 'no trf')
    const deshake = await tryRun(['-hide_banner', '-loglevel', 'error', '-y', '-i', 'shaky.mp4', '-vf', 'deshake', '-f', 'null', '-'], dir)
    expect.fail(`STEADY PROBE (temporary, Windows only) — ${listed.join(' ')} | made ${made} | detect ${detect} | transform ${transform} | ${trf} | deshake ${deshake}`)
  }, 180_000)
})
