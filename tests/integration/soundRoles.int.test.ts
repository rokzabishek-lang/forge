import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SOUND_ROLES } from '@shared/director/soundRoles'
import { measureSound } from '../../scripts/measure-sfx.mjs'
import { outputDir, writeNote } from './output'

/*
 * The sound table against the files (docs/PLAN.md §6.2): every peak in
 * `soundRoles.ts` is measured again here, with the same window the script
 * that filled it used, so a replaced file cannot keep a stale peak and a
 * length cannot drift. The library is not in the repository, so this runs
 * only where it is installed — this Mac — and CI reads the note instead.
 */

const ROOT = process.env.FORGE_ASSETS_DIR ?? resolve(__dirname, '../../assets')
const SFX = join(ROOT, 'sfxx')
const maybe = existsSync(SFX) ? describe : describe.skip

maybe('the sound table', () => {
  it('names each file’s length, peak and level as the bundled ffmpeg measures them', async () => {
    const dir = await outputDir('soundRoles')
    const lines = ['# soundRoles', '', 'Each file in the table, measured again: length, peak, level (10 ms RMS windows).', '']
    const drift: string[] = []
    let seen = 0
    for (const [name, entry] of Object.entries(SOUND_ROLES)) {
      const file = [join(SFX, name), join(SFX, 'cinematic', name)].find((f) => existsSync(f))
      if (!file) {
        lines.push(`- ${name}: not installed here`)
        continue
      }
      seen++
      const m = await measureSound(file)
      // The measurement is deterministic and steps in 5 ms; a peak a frame off at 30 fps is a hit landing late.
      const off = Math.abs(m.peakSeconds - entry.peakSeconds) > 0.011 || Math.abs(m.seconds - entry.seconds) > 0.02 || Math.abs(m.peakDb - entry.peakDb) > 0.6
      lines.push(`- ${name} (${entry.role}): ${m.seconds.toFixed(3)} s, peak ${m.peakSeconds.toFixed(3)} s at ${m.peakDb.toFixed(1)} dB — table ${entry.seconds} s, ${entry.peakSeconds} s, ${entry.peakDb} dB${off ? ' **DRIFT**' : ''}`)
      if (off) drift.push(name)
    }
    await writeNote(dir, lines)
    expect(seen, 'sounds installed to measure').toBeGreaterThan(0)
    expect(drift, 'files whose measurement no longer matches the table').toEqual([])
  }, 300_000)
})
