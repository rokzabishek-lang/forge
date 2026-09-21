import { describe, it, expect } from 'vitest'
import {
  MAX_CANDIDATES,
  MAX_SPEECH_CHARS,
  buildCutMenu,
  buildSlots,
  familyMenu,
  labelFor,
  minSegmentFrames
} from '@shared/director/menu'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject, type MediaAsset, type Project } from '@shared/timeline'
import type { Transcript } from '@shared/transcript'

const fps = 30

function asset(over: Partial<MediaAsset> & { id: string }): MediaAsset {
  return {
    path: `/p/${over.id}.jpg`,
    name: `${over.id}.jpg`,
    kind: 'image',
    durationFrames: fps * 5,
    width: 1600,
    height: 1067,
    fps: null,
    hasVideo: true,
    hasAudio: false,
    size: 12_345,
    ...over
  }
}

function music(bpm = 120, seconds = 30, over: Partial<MusicAnalysis> = {}): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 1),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000,
    ...over
  }
}

describe('buildSlots', () => {
  it('offers pictures and clips in pool order, never sound', () => {
    const project: Project = {
      ...emptyProject(),
      assets: [
        asset({ id: 'a' }),
        asset({ id: 'song', kind: 'audio', hasVideo: false, hasAudio: true }),
        asset({ id: 'b', kind: 'video', durationFrames: 72, fps })
      ]
    }
    const slots = buildSlots(project)
    expect(slots.map((s) => s.id)).toEqual(['slot_01', 'slot_02'])
    expect(slots.map((s) => s.assetId)).toEqual(['a', 'b'])
    expect(slots[1]).toMatchObject({ kind: 'video', seconds: 2.4, frames: 72 })
    expect(slots[0]).toMatchObject({ kind: 'image', seconds: null, frames: null })
  })

  it('leaves out everything the editor drew, by the mark they all carry', () => {
    /*
     * A baked text card has a real path and no clip once it has been cleared
     * or deleted — the first version of this offered those as product shots
     * named after last run's headlines. `size: 0` is what every self-drawn
     * asset is written with, and what no imported file ever has.
     */
    const project: Project = {
      ...emptyProject(),
      assets: [
        asset({ id: 'photo' }),
        asset({ id: 'text-asset-1', path: '/baked/card.png', name: 'Glow in 7 days', size: 0 }),
        asset({ id: 'paper-1', path: '', size: 0 })
      ]
    }
    expect(buildSlots(project).map((s) => s.assetId)).toEqual(['photo'])
  })

  it('carries the user note and the first words of a clip', () => {
    const words = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      text: `word${i}`,
      startMs: i * 300,
      endMs: i * 300 + 250,
      confidence: null
    }))
    const transcript: Transcript = {
      assetId: 'clip',
      language: 'en',
      model: 'test',
      durationMs: 12_000,
      words,
      segments: [
        {
          id: 's1',
          startMs: 0,
          endMs: 12_000,
          text: words.map((w) => w.text).join(' '),
          wordStart: 0,
          wordEnd: 39
        }
      ]
    }
    const project: Project = {
      ...emptyProject(),
      assets: [asset({ id: 'clip', kind: 'video', durationFrames: 360, fps }), asset({ id: 'still' })],
      transcripts: { clip: transcript }
    }
    const [clip, still] = buildSlots(project, { clip: '  unboxing, hands only ', still: '' })
    expect(clip.note).toBe('unboxing, hands only')
    expect(clip.speech.endsWith('…')).toBe(true)
    expect(clip.speech.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS + 1)
    // Cut at a word boundary, not mid-word.
    expect(clip.speech.replace('…', '').trim().endsWith('word')).toBe(false)
    expect(clip.speech.replace('…', '').trim()).toMatch(/word\d+$/)
    expect(still.speech).toBe('')
    expect(still.note).toBe('')
  })

  it('makes a filename readable', () => {
    expect(labelFor('IMG_4021-serum_bottle.jpg')).toBe('IMG 4021 serum bottle')
    expect(labelFor('product demo.MOV')).toBe('product demo')
    expect(labelFor('hero')).toBe('hero')
  })
})

describe('buildCutMenu', () => {
  const minFrames = minSegmentFrames(fps)

  function check(cuts: ReturnType<typeof buildCutMenu>): void {
    expect(cuts[0]).toMatchObject({ id: 'cut_00', reason: 'start' })
    expect(cuts[cuts.length - 1]).toMatchObject({ id: 'cut_end', reason: 'end' })
    expect(new Set(cuts.map((c) => c.id)).size).toBe(cuts.length)
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i].frame - cuts[i - 1].frame).toBeGreaterThanOrEqual(minFrames)
      expect(cuts[i].id > cuts[i - 1].id || cuts[i].id === 'cut_end').toBe(true)
    }
    expect(cuts.length).toBeLessThanOrEqual(MAX_CANDIDATES)
  }

  it('runs from a start to an end, sorted, unique, and never two within a shortest segment', () => {
    const cuts = buildCutMenu(music(), { fps, seconds: 30 })
    check(cuts)
    expect(cuts.length).toBeGreaterThan(6)
    expect(cuts.filter((c) => c.reason === 'grid').length).toBeGreaterThan(0)
  })

  it('never runs past the length asked for', () => {
    const cuts = buildCutMenu(music(120, 180), { fps, seconds: 15 })
    check(cuts)
    const end = cuts[cuts.length - 1]
    expect(end.ms).toBeLessThanOrEqual(15_000)
    expect(end.ms).toBeGreaterThan(12_000)
    for (const c of cuts) expect(c.ms).toBeLessThanOrEqual(end.ms)
  })

  it('ends on the beat within reach rather than an arbitrary millisecond', () => {
    // 120 BPM downbeats every 2 s; asking for 15 s lands on the 14 s downbeat.
    const cuts = buildCutMenu(music(120, 60), { fps, seconds: 15 })
    const end = cuts[cuts.length - 1]
    expect(end.ms).toBe(14_000)
    // A drop sitting there is carried onto the end, so the model still sees it.
    const withDrop = buildCutMenu(music(120, 60, { drops: [{ ms: 14_000, score: 0.9 }] }), { fps, seconds: 15 })
    expect(withDrop[withDrop.length - 1]).toMatchObject({ ms: 14_000, landsOn: 'drop' })
    expect(withDrop.filter((c) => c.reason === 'drop')).toHaveLength(0)
  })

  it('takes the timeline as the authority on the window, not the decode', () => {
    /*
     * The analysis came back 4.4 s short of the clip once, and the reel had
     * to stretch its last shot to cover the gap. Here the end is where the
     * clip ends on the timeline, whatever length of audio decoded.
     */
    const short = music(120, 25.6)
    const cuts = buildCutMenu(short, { fps, seconds: 30, windowMs: 30_000 })
    expect(cuts[cuts.length - 1].ms).toBe(30_000)
    // Nothing from the analysis lies past what it decoded, so the tail spans the shortfall.
    const before = cuts[cuts.length - 2]
    expect(before.ms).toBeLessThanOrEqual(25_600)
  })

  it('applies the timeline offset to frames and leaves ms relative to the window', () => {
    const cuts = buildCutMenu(music(), { fps, seconds: 10, offsetFrames: 90 })
    expect(cuts[0]).toMatchObject({ ms: 0, frame: 90 })
    expect(cuts[cuts.length - 1].frame).toBe(90 + cuts[cuts.length - 1].ms / 1000 * fps)
  })

  it('keeps every structural moment when thinning a long track', () => {
    // 170 BPM over 90 s is far more grid cuts than the cap; the drops must all survive.
    const drops = [11_000, 33_000, 55_000, 77_000].map((ms) => ({ ms, score: 0.9 }))
    const cuts = buildCutMenu(music(170, 90, { drops }), { fps, seconds: 90 })
    check(cuts)
    // Thinned to the cap — then deduped, which may take one or two more off.
    // "At most" is the rule; an exact count would pin the dedupe's luck.
    expect(cuts.length).toBeGreaterThanOrEqual(MAX_CANDIDATES - 3)
    const kept = cuts.filter((c) => c.reason === 'drop').map((c) => c.ms)
    // Snapped onto the grid by planCuts, so within a beat of where they were.
    for (const ms of [11_000, 33_000, 55_000, 77_000]) {
      expect(kept.some((k) => Math.abs(k - ms) < 400)).toBe(true)
    }
  })

  it('lays an even grid when there is no music, ending exactly where asked', () => {
    const cuts = buildCutMenu(null, { fps, seconds: 6.7 })
    expect(cuts.map((c) => c.ms)).toEqual([0, 2200, 4400, 6700])
    expect(cuts.map((c) => c.id)).toEqual(['cut_00', 'cut_01', 'cut_02', 'cut_end'])
    check(cuts)
  })

  it('collapses to a start and an end when there is no room for anything else', () => {
    const cuts = buildCutMenu(null, { fps, seconds: 0.1 })
    expect(cuts.map((c) => c.reason)).toEqual(['start', 'end'])
    check(cuts)
  })

  it('folds a structural cut that collides with the end into it', () => {
    // A section boundary on the last frame would otherwise sit one frame before the end.
    const cuts = buildCutMenu(music(120, 30, { sections: [29_990] }), { fps, seconds: 30 })
    check(cuts)
    expect(cuts.filter((c) => c.reason === 'section')).toHaveLength(0)
  })
})

describe('familyMenu', () => {
  it('offers cut first, then only the families that are installed', () => {
    const families = familyMenu(TRANSITIONS)
    expect(families[0].id).toBe('cut')
    const ids = families.map((f) => f.id)
    // The built-ins cover these four; the mask packs add the rest.
    for (const present of ['dissolve', 'slide', 'zoom', 'smooth']) expect(ids).toContain(present)
    expect(ids).not.toContain('glitch')
    for (const f of families) expect(f.intent.length).toBeGreaterThan(3)
  })

  it('is just cut when nothing is installed', () => {
    expect(familyMenu([]).map((f) => f.id)).toEqual(['cut'])
  })
})
