import { describe, it, expect } from 'vitest'
import {
  worthRecovering,
  autosaveName,
  RECOVERY_MARGIN_MS,
  AUTOSAVE_INTERVAL_MS,
  type AutosaveRecord
} from '@shared/project/recovery'
import { serializeProject, deserializeProject } from '@shared/project'
import { emptyProject, newProjectId } from '@shared/timeline'
import {
  BUILT_IN_PRESETS,
  isBuiltIn,
  newPresetId,
  pathForPreset,
  sanePreset,
  CRF_MIN,
  CRF_MAX
} from '@shared/render/presets'

const record = (over: Partial<AutosaveRecord> = {}): AutosaveRecord => ({
  projectId: 'p1',
  file: '/auto/p1.forge.json',
  savedAt: 1_000_000,
  projectPath: '/work/ad.forge',
  projectSavedAt: 900_000,
  name: 'Ad',
  ...over
})

describe('which autosaves are worth offering back', () => {
  it('offers one that is newer than the file it shadows', () => {
    expect(worthRecovering([record()])).toHaveLength(1)
  })

  it('stays quiet when the saved file already has the work', () => {
    /*
     * The important half. An autosave older than the file holds work the user
     * has already saved over, and restoring it would UNDO the save rather than
     * recover from a crash — a recovery prompt that loses work is worse than
     * none at all.
     */
    expect(worthRecovering([record({ savedAt: 800_000, projectSavedAt: 900_000 })])).toEqual([])
  })

  it('ignores an autosave that is only moments newer', () => {
    /*
     * Saving writes the real file and the autosave timer may fire just after.
     * Without a margin every ordinary save would leave a recovery waiting at
     * the next launch, and a prompt that appears every single time is one
     * nobody reads.
     */
    const inside = record({ savedAt: 900_000 + RECOVERY_MARGIN_MS - 1, projectSavedAt: 900_000 })
    const outside = record({ savedAt: 900_000 + RECOVERY_MARGIN_MS + 1, projectSavedAt: 900_000 })
    expect(worthRecovering([inside])).toEqual([])
    expect(worthRecovering([outside])).toHaveLength(1)
  })

  it('always offers an autosave of a project that was never saved', () => {
    // There is nothing else: the file does not exist, so the autosave is the
    // only copy of that work in the world.
    expect(worthRecovering([record({ projectPath: null, projectSavedAt: null })])).toHaveLength(1)
  })

  it('puts the newest first', () => {
    const found = worthRecovering([
      record({ projectId: 'old', savedAt: 1_000_000 }),
      record({ projectId: 'new', savedAt: 3_000_000 }),
      record({ projectId: 'mid', savedAt: 2_000_000 })
    ])
    expect(found.map((r) => r.projectId)).toEqual(['new', 'mid', 'old'])
  })

  it('autosaves often enough to matter and rarely enough to ignore', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBeGreaterThanOrEqual(15_000)
    expect(AUTOSAVE_INTERVAL_MS).toBeLessThanOrEqual(120_000)
  })
})

describe('the autosave filename', () => {
  it('is derived from the project id, not its path', () => {
    // A project saved under a new name is the same work; keying on the path
    // would orphan the old autosave and offer it back as a different project.
    expect(autosaveName('p-abc123')).toBe('p-abc123.forge.json')
  })

  it('cannot become a path, however the id was written', () => {
    /*
     * A project file is a JSON document a user can edit, and its id reaches a
     * filename. `../../etc/passwd` has to come out as a harmless name.
     */
    for (const nasty of ['../../etc/passwd', 'a/b\\c', 'x:y|z?*"<>', '..', './..']) {
      const name = autosaveName(nasty)
      expect(name, nasty).not.toMatch(/[/\\]/)
      // Windows' illegal set, used on both platforms because it is the strict one.
      expect(name, nasty).not.toMatch(/[<>:"|?*]/)
      expect(name.startsWith('..'), nasty).toBe(false)
    }
  })

  it('gives a name to an id that sanitises away to nothing', () => {
    // `...` is all legal characters and not a usable name; so is an empty id.
    expect(autosaveName('...')).toBe('project.forge.json')
    expect(autosaveName('')).toBe('project.forge.json')
    expect(autosaveName('///')).toBe('project.forge.json')
  })

  it('does not grow without bound from a long id', () => {
    // Filesystems cap a component at 255 bytes; a project file could carry
    // any string at all.
    expect(autosaveName('x'.repeat(10_000)).length).toBeLessThan(120)
  })
})

describe('a project carries its own identity', () => {
  it('is minted for a new project', () => {
    const a = emptyProject()
    const b = emptyProject()
    expect(a.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
    expect(newProjectId()).not.toBe(newProjectId())
  })

  it('survives a save and reopen', () => {
    const project = emptyProject('Ad')
    const file = serializeProject(project, { appVersion: '1.0.0' })
    const back = deserializeProject(JSON.parse(JSON.stringify(file)))
    expect(back.project.id).toBe(project.id)
  })

  it('is minted for a file written before ids existed', () => {
    /*
     * Every project saved before this must still open, and must still get an
     * autosave key — so the id is filled in on the way in rather than left
     * undefined for everything downstream to guard against.
     */
    const file = serializeProject(emptyProject('Old'), { appVersion: '1.0.0' })
    const raw = JSON.parse(JSON.stringify(file)) as { project: Record<string, unknown> }
    delete raw.project.id

    const back = deserializeProject(raw)
    expect(typeof back.project.id).toBe('string')
    expect(back.project.id).toBeTruthy()
    // And the autosave name built from it is usable.
    expect(autosaveName(back.project.id!)).toMatch(/^p-[a-z0-9-]+\.forge\.json$/)
  })
})

describe('export presets', () => {
  it('ships three, covering the aspects this app exists to serve', () => {
    /*
     * An empty picker teaches nothing — it does not say what a preset IS, and
     * the first thing anyone would have to do is work out what to put in one.
     */
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.aspect))).toEqual(new Set(['9:16', '1:1', '16:9']))
    for (const preset of BUILT_IN_PRESETS) expect(isBuiltIn(preset)).toBe(true)
    expect(isBuiltIn({ id: newPresetId() })).toBe(false)
  })

  it('gives each one a different suffix, or two exports overwrite each other', () => {
    // Both are named after the project; without suffixes the second silently
    // replaces the first.
    const suffixes = BUILT_IN_PRESETS.map((p) => p.suffix)
    expect(new Set(suffixes).size).toBe(suffixes.length)
    expect(suffixes.every((s) => s.length > 0)).toBe(true)
  })

  it('puts the suffix before the extension, not after it', () => {
    const preset = { ...BUILT_IN_PRESETS[0], suffix: '-9x16' }
    expect(pathForPreset('/out/ad.mp4', preset)).toBe('/out/ad-9x16.mp4')
    // A path whose only dot is in a DIRECTORY name has no extension to sit
    // before — appending is right, and inserting would corrupt the folder.
    expect(pathForPreset('/out.dir/ad', preset)).toBe('/out.dir/ad-9x16')
    expect(pathForPreset('C:\\a.b\\ad', preset)).toBe('C:\\a.b\\ad-9x16')
    expect(pathForPreset('/out/ad.mp4', { ...preset, suffix: '' })).toBe('/out/ad.mp4')
  })

  it('brings a hand-edited preset back into range', () => {
    /*
     * The settings file is JSON on a user's disk. A CRF of 900 or an aspect
     * that no longer exists must not reach ffmpeg — a bad preset should export
     * something slightly wrong, not fail at the encoder with a message about
     * an option nobody set.
     */
    const clean = sanePreset(
      {
        id: 'x', name: '  Wide  ', aspect: '4:3' as never, crf: 900,
        preset: 'ludicrous' as never, loudness: -900, captions: 'yes' as never,
        suffix: 'a/b:c*?'
      },
      BUILT_IN_PRESETS[0]
    )
    expect(clean.crf).toBeLessThanOrEqual(CRF_MAX)
    expect(clean.crf).toBeGreaterThanOrEqual(CRF_MIN)
    expect(clean.aspect).toBe(BUILT_IN_PRESETS[0].aspect)
    expect(clean.preset).toBe(BUILT_IN_PRESETS[0].preset)
    expect(clean.loudness).toBeGreaterThanOrEqual(-30)
    expect(clean.captions).toBe(BUILT_IN_PRESETS[0].captions)
    expect(clean.name).toBe('Wide')
  })

  it('keeps a suffix legal as a FILENAME on both platforms', () => {
    // `Bride 5:30pm` is an ordinary thing for someone to type, and a colon is
    // illegal on Windows — plus a trailing dot or space, which are too.
    const clean = sanePreset({ suffix: ' 5:30pm <v2>. ' }, BUILT_IN_PRESETS[0])
    expect(clean.suffix).not.toMatch(/[<>:"|?*\\/]/)
    expect(clean.suffix).not.toMatch(/[. ]$/)
  })

  it('keeps null loudness as "leave the mix alone"', () => {
    // Distinct from "no value given", which falls back to the preset's own.
    expect(sanePreset({ loudness: null }, BUILT_IN_PRESETS[0]).loudness).toBeNull()
    expect(sanePreset({}, BUILT_IN_PRESETS[0]).loudness).toBe(BUILT_IN_PRESETS[0].loudness)
  })
})
