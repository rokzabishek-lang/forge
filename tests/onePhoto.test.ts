import { describe, it, expect } from 'vitest'
import { planOnePhotoReel, planCards, onePhotoClips, ONE_PHOTO_RULE } from '@shared/automation/onePhoto'
import { readsAsCut } from '@shared/automation/framing'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject } from '@shared/timeline'
import type { CropRect } from '@shared/timeline'

const FPS = 30
const PHOTO = { width: 6000, height: 4000 }
const SUBJECT: CropRect = { x: 2200, y: 900, width: 1300, height: 2700 }
const VERTICAL = 1080 / 1920

/** Thirty seconds of a steady 120 BPM track: a beat every 500ms, bars of 2s. */
function analysis(over: Partial<MusicAnalysis> = {}): MusicAnalysis {
  const durationMs = 30_000
  const beats = Array.from({ length: 60 }, (_, i) => i * 500)
  return {
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 2),
    drops: [{ ms: 16_000, score: 0.9 }],
    buildups: [],
    sections: [0, 16_000],
    durationMs,
    ...over
  }
}

const base = {
  analysis: analysis(),
  fps: FPS,
  source: PHOTO,
  aspectRatio: VERTICAL,
  outputHeight: 1920,
  subject: SUBJECT
}

describe('planOnePhotoReel', () => {
  it('turns one photograph into a sequence of different shots', () => {
    const { shots } = planOnePhotoReel(base)
    expect(shots.length).toBeGreaterThan(4)
    expect(new Set(shots.map((s) => s.framing)).size).toBeGreaterThan(1)
  })

  it('never cuts between two framings that would read as a jump', () => {
    /*
     * With one photograph this is the whole game. If consecutive frames are too
     * similar the audience sees the edit rather than the subject.
     */
    const { shots, ladder } = planOnePhotoReel(base)
    const byLabel = new Map(ladder.map((f) => [f.label, f]))
    for (let i = 1; i < shots.length; i++) {
      const a = byLabel.get(shots[i - 1].framing)!
      const b = byLabel.get(shots[i].framing)!
      if (a === b) continue
      expect(readsAsCut(a, b)).toBe(true)
    }
  })

  it('keeps shots back to back, with no gaps to render as black', () => {
    const { shots } = planOnePhotoReel(base)
    for (let i = 1; i < shots.length; i++) {
      const previousEnd = shots[i - 1].startFrame + shots[i - 1].durationFrames
      expect(shots[i].startFrame).toBeLessThanOrEqual(previousEnd)
    }
  })

  it('holds the frame and shakes on the drop instead of moving the camera', () => {
    const { shots } = planOnePhotoReel(base)
    const onDrop = shots.find((s) => s.reason.includes('on the drop'))
    expect(onDrop?.motion?.kind).toBe('shake')
  })

  it('says why every shot exists', () => {
    // Automation writes clips the user can read, argue with and delete.
    for (const shot of planOnePhotoReel(base).shots) {
      expect(shot.reason).toMatch(/wide|looking away|medium|close|detail/)
      expect(shot.reason).toMatch(/beat|drop|section|build/)
    }
  })

  describe('depth', () => {
    it('uses parallax only where a crop would not fight it', () => {
      /*
       * Depth planes are composited at the bake's resolution, not the photo's,
       * so a crop in source pixels would land somewhere else entirely. Parallax
       * belongs to the full-frame shots.
       */
      for (const shot of planOnePhotoReel({ ...base, hasDepth: true }).shots) {
        if (shot.motion?.kind === 'parallax') expect(shot.crop).toBeNull()
        if (shot.crop) expect(shot.motion?.kind).not.toBe('parallax')
      }
    })

    it('anchors the shake on the subject when it has a cutout to hold still', () => {
      const withDepth = planOnePhotoReel({ ...base, hasDepth: true }).shots
      const shake = withDepth.find((s) => s.motion?.kind === 'shake' && s.crop === null)
      expect(shake?.motion).toMatchObject({ anchor: 'subject' })
    })

    it('still plans a whole reel with no depth at all', () => {
      const flat = planOnePhotoReel({ ...base, hasDepth: false })
      expect(flat.shots.length).toBeGreaterThan(4)
      for (const shot of flat.shots) expect(shot.motion?.kind).not.toBe('parallax')
    })
  })

  it('moves the camera less inside a tight crop, which has less room', () => {
    const { shots, ladder } = planOnePhotoReel(base)
    const tightest = ladder.reduce((a, b) => (a.scale > b.scale ? a : b))
    const tight = shots.find((s) => s.framing === tightest.label && s.motion?.kind === 'kenburns')
    const wide = shots.find((s) => s.framing === 'wide' && s.motion?.kind === 'kenburns')
    if (tight && wide && tightest.scale > 2) {
      expect(tight.motion!.amount).toBeLessThan(wide.motion!.amount)
    }
  })

  it('plans nothing rather than crashing on an empty analysis', () => {
    const empty = planOnePhotoReel({
      ...base,
      analysis: { ...analysis(), beats: [], downbeats: [], tiers: [], sections: [], durationMs: 0 }
    })
    expect(empty.shots).toEqual([])
  })
})

describe('planCards', () => {
  it('lands every card on a bar', () => {
    const a = analysis()
    const cards = planCards('she said yes\nand we cried\nand the sun came up', a, FPS)
    expect(cards.length).toBe(3)
    for (const card of cards) {
      const ms = (card.startFrame / FPS) * 1000
      expect(a.downbeats.some((d) => Math.abs(d - ms) < 20)).toBe(true)
    }
  })

  it('holds each card for whole bars, back to back', () => {
    const cards = planCards('one\ntwo\nthree', analysis(), FPS)
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].startFrame).toBe(cards[i - 1].startFrame + cards[i - 1].durationFrames)
    }
  })

  it('splits the same caption differently against a faster song', () => {
    // The tempo decides how many words fit, because the bar is the reading time.
    const caption = 'the morning light before anyone else was awake and the house was still quiet'
    const slow = planCards(caption, analysis({ bpm: 100 }), FPS)
    const fast = planCards(caption, analysis({ bpm: 170 }), FPS)
    expect(fast.length).toBeGreaterThanOrEqual(slow.length)
  })

  it('never runs a card past the end of the music', () => {
    const a = analysis()
    const many = planCards(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'), a, FPS)
    for (const card of many) {
      expect(card.startFrame).toBeLessThan((a.durationMs / 1000) * FPS)
    }
  })

  it('falls back to a tempo grid when the analyser found no downbeats', () => {
    // A caption should still land sensibly on a track the analyser struggled with.
    const rough = analysis({ downbeats: [], beats: [] })
    const cards = planCards('still works\nfine', rough, FPS)
    expect(cards).toHaveLength(2)
    expect(cards[0].durationFrames).toBeGreaterThan(0)
  })

  it('gives nothing back for no caption', () => {
    expect(planCards('', analysis(), FPS)).toEqual([])
    expect(planCards('   \n  ', analysis(), FPS)).toEqual([])
  })
})

describe('onePhotoClips', () => {
  const project = emptyProject()
  const trackId = project.tracks.find((t) => t.kind === 'video')!.id

  it('writes ordinary clips the user can see and delete', () => {
    const { shots } = planOnePhotoReel(base)
    const clips = onePhotoClips(project, shots, trackId, 'asset-1')
    expect(clips).toHaveLength(shots.length)
    for (const clip of clips) {
      expect(clip.generatedBy?.rule).toBe(ONE_PHOTO_RULE)
      expect(clip.generatedBy?.reason).toBeTruthy()
    }
  })

  it('fills the canvas rather than letterboxing a landscape photo', () => {
    const { shots } = planOnePhotoReel(base)
    for (const clip of onePhotoClips(project, shots, trackId, 'asset-1')) {
      expect(clip.transform.fit).toBe('cover')
    }
  })

  it('does not stack every clip on the same frame', () => {
    const { shots } = planOnePhotoReel(base)
    const clips = onePhotoClips(project, shots, trackId, 'asset-1')
    expect(new Set(clips.map((c) => c.start)).size).toBe(clips.length)
  })
})
