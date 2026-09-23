import { describe, it, expect } from 'vitest'
import { FFMPEG, run } from './output'
import { whiteBalanceGains } from '@shared/render/whiteBalance'

/*
 * TEMPORARY — a measurement, not a guard. Delete once it has answered.
 *
 * The Windows runner renders white balance uniformly 3–4 levels darker than
 * the gains predict, in every channel of every balance (CI #79): warm
 * 149,120,89 against 154.6,123.7,92.7. The macOS build is exact, so the cause
 * cannot be measured here. This runs on the Windows runner only and FAILS ON
 * PURPOSE with the whole table in its message — CI annotations carry a
 * failure's message, and nothing else is readable without signing in.
 *
 * Each route takes a mid grey to the mixer and back, and reads the centre
 * pixel the way the render checks do. `none` is the grey with no mixer; the
 * `roundtrip` routes convert to RGB and back without mixing, to see whether
 * the conversion alone is what darkens.
 */

const onWindows = process.platform === 'win32'

async function centre(vf: string): Promise<string> {
  try {
    const { stdout } = await run(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=64x64:d=1',
        '-vf', `${vf},format=yuv420p`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { encoding: 'buffer', maxBuffer: 1 << 22 }
    )
    const b = stdout as unknown as Buffer
    const i = (32 * 64 + 32) * 3
    return `${b[i]},${b[i + 1]},${b[i + 2]}`
  } catch (e) {
    return `ERROR ${String(e).split('\n').slice(-2).join(' ').slice(0, 120)}`
  }
}

describe.runIf(onWindows)('white balance on the 2018 build — where the darkening comes from', () => {
  it('reports every route', async () => {
    const g = whiteBalanceGains(1, 0)
    const ccm = `colorchannelmixer=rr=${g.r.toFixed(4)}:gg=${g.g.toFixed(4)}:bb=${g.b.toFixed(4)}`
    const routes: [string, string][] = [
      ['none', 'format=yuva420p'],
      ['roundtrip gbrap', 'format=yuva420p,format=gbrap,format=yuva420p'],
      ['roundtrip rgba', 'format=yuva420p,format=rgba,format=yuva420p'],
      ['roundtrip rgb24 (no alpha)', 'format=yuv420p,format=rgb24,format=yuv420p'],
      ['mixer, as the plan', `format=yuva420p,${ccm}`],
      ['mixer via gbrap', `format=yuva420p,format=gbrap,${ccm},format=yuva420p`],
      ['mixer via rgba', `format=yuva420p,format=rgba,${ccm},format=yuva420p`],
      ['mixer, no alpha', `format=yuv420p,${ccm}`],
      ['mixer, explicit ranges', `format=yuva420p,scale=in_range=tv:out_range=pc,format=gbrap,${ccm},scale=in_range=pc:out_range=tv,format=yuva420p`],
      ['unity mixer, as the plan', 'format=yuva420p,colorchannelmixer=rr=1:gg=1:bb=1']
    ]
    const rows: string[] = [`gains ${g.r.toFixed(4)},${g.g.toFixed(4)},${g.b.toFixed(4)}`]
    for (const [name, vf] of routes) rows.push(`${name}: ${await centre(vf)}`)
    expect.fail(`WB PROBE (temporary, Windows only) — ${rows.join(' | ')}`)
  }, 120_000)
})
