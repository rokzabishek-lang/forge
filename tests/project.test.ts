import { describe, it, expect } from 'vitest'
import {
  serializeProject,
  deserializeProject,
  ProjectFormatError,
  SCHEMA_VERSION,
  type DecisionRecord
} from '@shared/project'
import { emptyProject, type Clip, type MediaAsset } from '@shared/timeline'

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'a1', path: '/m/a.mp4', name: 'a.mp4', kind: 'video',
    durationFrames: 300, width: 1920, height: 1080, fps: 30,
    hasVideo: true, hasAudio: true, size: 10, ...over
  }
}

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
  }
}

const populated = () => ({ ...emptyProject('Demo'), assets: [asset()], clips: [clip()] })

describe('round trip', () => {
  it('survives serialize → JSON → deserialize unchanged', () => {
    const original = populated()
    const file = serializeProject(original, { appVersion: '1.2.3' })
    const parsed = deserializeProject(JSON.parse(JSON.stringify(file)))

    expect(parsed.project).toEqual(original)
    expect(parsed.app.version).toBe('1.2.3')
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('preserves frame positions exactly', () => {
    const original = { ...populated(), clips: [clip({ start: 1_000_001, duration: 7, inPoint: 42 })] }
    const parsed = deserializeProject(JSON.parse(JSON.stringify(serializeProject(original))))
    expect(parsed.project.clips[0]).toMatchObject({ start: 1_000_001, duration: 7, inPoint: 42 })
  })
})

describe('director decisions', () => {
  it('persists decisions with their model stamp', () => {
    const decision: DecisionRecord = {
      id: 'd1',
      pass: 'select',
      ops: [{ op: 'set_bounds', start_ref: 'S47', end_ref: 'S62' }],
      model: { id: 'qwen3.5-4b', quantHash: 'abc123', runtime: 'llama.cpp-b1234' },
      createdAt: '2026-09-11T00:00:00.000Z'
    }
    const file = serializeProject(populated(), { appVersion: '1.0.0', decisions: [decision] })
    const parsed = deserializeProject(JSON.parse(JSON.stringify(file)))

    // Reopening must show the same edit without re-running the model.
    expect(parsed.decisions).toEqual([decision])
  })

  it('defaults to an empty decision list for projects that never ran the director', () => {
    const parsed = deserializeProject(JSON.parse(JSON.stringify(serializeProject(populated()))))
    expect(parsed.decisions).toEqual([])
  })
})

describe('validation', () => {
  it('rejects a file from a newer schema instead of silently mangling it', () => {
    const file = { ...serializeProject(populated()), schemaVersion: SCHEMA_VERSION + 1 }
    expect(() => deserializeProject(file)).toThrow(/newer version of Forge/)
  })

  it('rejects a file with no schema version', () => {
    expect(() => deserializeProject({ project: populated() })).toThrow(ProjectFormatError)
  })

  it('rejects clips pointing at media the project does not contain', () => {
    const broken = serializeProject({ ...populated(), clips: [clip({ assetId: 'gone' })] })
    // Caught at load so the UI can offer a relink, rather than failing mid-export.
    expect(() => deserializeProject(JSON.parse(JSON.stringify(broken)))).toThrow(/not in the project/)
  })

  it('rejects invalid project settings', () => {
    const file = serializeProject(populated())
    const broken = { ...file, project: { ...file.project, settings: { ...file.project.settings, fps: 0 } } }
    expect(() => deserializeProject(JSON.parse(JSON.stringify(broken)))).toThrow(/fps/)
  })

  it('rejects non-objects', () => {
    expect(() => deserializeProject('nope')).toThrow(ProjectFormatError)
    expect(() => deserializeProject(null)).toThrow(ProjectFormatError)
  })

  it('tolerates unknown fields from a future minor build', () => {
    const file = { ...serializeProject(populated()), somethingNew: { a: 1 } }
    expect(() => deserializeProject(JSON.parse(JSON.stringify(file)))).not.toThrow()
  })

  it('backfills settings a partial file omitted', () => {
    const file = serializeProject(populated())
    const partial = {
      ...file,
      project: { ...file.project, settings: { width: 1280, height: 720, fps: 24 } }
    }
    const parsed = deserializeProject(JSON.parse(JSON.stringify(partial)))
    // sampleRate was absent; the default fills in rather than becoming undefined.
    expect(parsed.project.settings.sampleRate).toBe(48000)
    expect(parsed.project.settings.fps).toBe(24)
  })
})

describe('transcripts', () => {
  const transcript = {
    assetId: 'a1',
    language: 'en',
    model: 'faster-whisper/tiny/int8',
    durationMs: 11000,
    words: [
      { index: 0, text: 'And', startMs: 0, endMs: 740, confidence: 0.7054 },
      { index: 1, text: 'so', startMs: 740, endMs: 1080, confidence: 0.9074 }
    ],
    segments: [
      { id: 's1', startMs: 0, endMs: 1080, text: 'And so', wordStart: 0, wordEnd: 1 }
    ]
  }

  it('round-trips with the project, so ASR never has to re-run', () => {
    const original = { ...populated(), transcripts: { a1: transcript } }
    const parsed = deserializeProject(JSON.parse(JSON.stringify(serializeProject(original))))

    expect(parsed.project.transcripts.a1).toEqual(transcript)
    // Millisecond precision must survive exactly — captions are timed off these.
    expect(parsed.project.transcripts.a1.words[0].endMs).toBe(740)
  })

  it('backfills an empty map for projects saved before transcripts existed', () => {
    const file = serializeProject(populated())
    const legacy = { ...file, project: { ...file.project } }
    delete (legacy.project as Record<string, unknown>).transcripts

    const parsed = deserializeProject(JSON.parse(JSON.stringify(legacy)))
    expect(parsed.project.transcripts).toEqual({})
  })
})

describe('caption settings', () => {
  it('round-trips with the project', () => {
    const original = { ...populated(), captions: { enabled: false, styleId: 'clean' } }
    const parsed = deserializeProject(JSON.parse(JSON.stringify(serializeProject(original))))
    expect(parsed.project.captions).toEqual({ enabled: false, styleId: 'clean' })
  })

  it('backfills defaults for projects saved before captions existed', () => {
    const file = serializeProject(populated())
    const legacy = { ...file, project: { ...file.project } }
    delete (legacy.project as Record<string, unknown>).captions

    const parsed = deserializeProject(JSON.parse(JSON.stringify(legacy)))
    expect(parsed.project.captions.enabled).toBe(true)
    expect(parsed.project.captions.styleId).toBe('pop')
  })

  it('merges a partially-specified caption block onto the defaults', () => {
    const file = serializeProject(populated())
    const partial = {
      ...file,
      project: { ...file.project, captions: { styleId: 'bold-center' } }
    }
    const parsed = deserializeProject(JSON.parse(JSON.stringify(partial)))
    expect(parsed.project.captions.styleId).toBe('bold-center')
    // enabled was absent and must not become undefined.
    expect(parsed.project.captions.enabled).toBe(true)
  })
})
