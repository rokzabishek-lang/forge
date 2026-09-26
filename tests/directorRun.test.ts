import { describe, expect, it } from 'vitest'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { adSeconds, briefFor, expectedRecipe, menuFor, musicFor, type BriefDraft } from '@shared/director/run'
import { ENERGY, WEDDING_HIGHLIGHT } from '@shared/director/recipes'

/**
 * What `direct()` decides before it asks (shared/director/run.ts) — the music,
 * the ad's length, the brief and the menu. The store and the Director eval
 * both call these, so a rule changed here changes both at once; these tests
 * pin the rules `direct()` had inline before they moved.
 */

const asset = (over: Partial<MediaAsset>): MediaAsset => ({
  id: 'x', path: '/m/x', name: 'x', kind: 'audio', durationFrames: 900, width: null, height: null,
  fps: null, hasVideo: false, hasAudio: true, size: 100, ...over
})

const clip = (over: Partial<Clip>): Clip => ({
  id: 'c', assetId: 'x', trackId: 'a1', start: 0, duration: 900, inPoint: 0, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
})

function project(assets: MediaAsset[], clips: Clip[]): Project {
  return { ...emptyProject(), assets, clips }
}

const draft = (over: Partial<BriefDraft> = {}): BriefDraft => ({
  product: '  Serum  ', benefit: '', audience: ' women ', tone: 'premium', cta: '', seconds: null, language: '', ...over
})

describe('the music', () => {
  it('is the first clip on an audio track whose file has sound, and its window is the clip on the timeline', () => {
    const p = project(
      [asset({ id: 'silent', hasAudio: false }), asset({ id: 'song' })],
      [
        clip({ id: 'mute', assetId: 'silent', trackId: 'a1' }),
        clip({ id: 'song-clip', assetId: 'song', trackId: 'a2', start: 60, inPoint: 90, duration: 450 })
      ]
    )
    const m = musicFor(p)!
    expect(m.clip.id).toBe('song-clip')
    // 450 frames at 30 fps; the file is read from its in-point.
    expect(m.windowMs).toBe(15_000)
    expect(m.startMs).toBe(3000)
    expect(m.endMs).toBe(18_000)
  })

  it('is never a clip on a video track, even one with sound', () => {
    const p = project([asset({ id: 'v', kind: 'video', hasVideo: true })], [clip({ assetId: 'v', trackId: 'v1' })])
    expect(musicFor(p)).toBeNull()
  })
})

describe('how long the ad is', () => {
  const p = project([asset({ id: 'song' })], [clip({ assetId: 'song', duration: 600 })])

  it('is what the brief asked for, when it asked', () => {
    expect(adSeconds({ seconds: 12 }, musicFor(p))).toBe(12)
  })

  it('is otherwise thirty seconds or the music, whichever is shorter', () => {
    expect(adSeconds({ seconds: null }, musicFor(p))).toBe(20)
    const long = project([asset({ id: 'song' })], [clip({ assetId: 'song', duration: 3000 })])
    expect(adSeconds({ seconds: null }, musicFor(long))).toBe(30)
    expect(adSeconds({ seconds: null }, null)).toBe(30)
  })

  it('is sixty seconds for a wedding — the teaser — or the music if that is shorter; thirty for the others', () => {
    const long = project([asset({ id: 'song' })], [clip({ assetId: 'song', duration: 3000 })])
    expect(adSeconds({ seconds: null }, musicFor(long), WEDDING_HIGHLIGHT)).toBe(60)
    expect(adSeconds({ seconds: null }, musicFor(p), WEDDING_HIGHLIGHT)).toBe(20)
    expect(adSeconds({ seconds: null }, null, WEDDING_HIGHLIGHT)).toBe(60)
    expect(adSeconds({ seconds: null }, musicFor(long), ENERGY)).toBe(30)
    // What the brief asked for still wins.
    expect(adSeconds({ seconds: 15 }, musicFor(long), WEDDING_HIGHLIGHT)).toBe(15)
  })

  it('is decided by the recipe EXPECTED before anything is seen: the pinned one, or the tone’s from the brief’s words', () => {
    expect(expectedRecipe(draft({ tone: 'premium', product: 'Priya & Arjun', benefit: 'our wedding day' }), null).id).toBe('wedding-highlight')
    expect(expectedRecipe(draft({ tone: 'premium', product: 'Aura serum' }), null).id).toBe('product-reveal')
    expect(expectedRecipe(draft({ tone: 'premium', product: 'Priya & Arjun', benefit: 'our wedding day' }), ENERGY).id).toBe('energy')
    // A calm brief the pictures alone would reveal as a wedding: the eyes have not run yet.
    expect(expectedRecipe(draft({ tone: 'calm', product: 'Priya & Arjun' }), null).id).toBe('fashion')
  })
})

describe('the brief the model sees', () => {
  it('is trimmed, with the blanks filled from the product and the defaults', () => {
    expect(briefFor(draft(), 20)).toEqual({
      product: 'Serum', benefit: 'Serum', audience: 'women', tone: 'premium', cta: 'Shop now', seconds: 20, language: 'English'
    })
  })

  it('keeps what the user wrote', () => {
    const b = briefFor(draft({ benefit: 'glow', cta: 'Buy', language: 'Telugu' }), 15)
    expect([b.benefit, b.cta, b.language, b.seconds]).toEqual(['glow', 'Buy', 'Telugu', 15])
  })
})

describe('the menu', () => {
  it('is offset by where the music starts, and capped by its window', () => {
    const p = project([asset({ id: 'song' })], [clip({ assetId: 'song', start: 90, duration: 300 })])
    const m = musicFor(p)
    const menu = menuFor(p, [], m, null, [{ id: 'fade', family: 'dissolve' }], 30)
    expect(menu.cuts[0].frame).toBe(90)
    // Ten seconds of music: the ad cannot outlast it, whatever the brief says.
    expect(menu.cuts.at(-1)!.frame).toBeLessThanOrEqual(90 + 300)
    expect(menu.families.map((f) => f.id)).toEqual(['cut', 'dissolve'])
    expect([menu.seconds, menu.fps]).toEqual([30, 30])
  })
})
