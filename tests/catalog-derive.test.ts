import { describe, it, expect } from 'vitest'
import { fontFamilies, searchEntries, stickerCategoryLabel } from '@shared/assets/catalog'
import type { AssetCatalog } from '@shared/assets/catalog'

function catalog(entries: AssetCatalog['entries']): AssetCatalog {
  return { version: 1, generatedAt: '', scannedFrom: '/a', entries }
}

const font = (id: string, family: string) => ({
  id, kind: 'font' as const, name: family, file: `fonts/${id}.ttf`,
  tags: [family], meta: { family, source: 'bundled' as const }
})

describe('fontFamilies', () => {
  it('collapses multiple weights into one family', () => {
    const result = fontFamilies(
      catalog([font('a', 'Anton'), font('b', 'Anton'), font('c', 'Bebas Neue')])
    )
    expect(result.map((f) => f.name)).toEqual(['Anton', 'Bebas Neue'])
  })

  it('returns an empty list for a missing catalog rather than throwing', () => {
    expect(fontFamilies(null)).toEqual([])
  })

  it('ignores non-font entries', () => {
    const result = fontFamilies(
      catalog([
        font('a', 'Anton'),
        { id: 's', kind: 'sfx', name: 'boom', file: 'sfx/b.wav', tags: [], meta: { durationMs: null } }
      ])
    )
    expect(result).toHaveLength(1)
  })
})

describe('searchEntries', () => {
  it('handles a null catalog', () => {
    expect(searchEntries(null, 'anything')).toEqual([])
  })

  it('scopes by kind', () => {
    const c = catalog([
      font('a', 'Anton'),
      { id: 's', kind: 'sfx', name: 'anton boom', file: 'sfx/b.wav', tags: ['anton'], meta: { durationMs: null } }
    ])
    expect(searchEntries(c, 'anton', 'font')).toHaveLength(1)
    expect(searchEntries(c, 'anton')).toHaveLength(2)
  })
})

describe('sticker category chips', () => {
  it('shortens a pack name enough to be a chip', () => {
    /*
     * Sheet ⑨ draws a category row, and the panel is about 280px wide. The
     * packs are named for a filesystem, and printing those in full gives ten
     * chips that wrap to five rows and stop being a row at all.
     */
    expect(stickerCategoryLabel('01_Telugu_Memes_and_Punchlines')).toBe('Telugu Memes')
    expect(stickerCategoryLabel('05_SpongeBob_Cutaways')).toBe('SpongeBob Cutaways')
    expect(stickerCategoryLabel('11_Middle_Eastern_and_Global_Culture')).toBe('Middle Eastern')
  })

  it('never ends on a conjunction', () => {
    // `Tech_and_Business_Titans` would otherwise read "Tech and".
    expect(stickerCategoryLabel('07_Tech_and_Business_Titans')).toBe('Tech')
    expect(stickerCategoryLabel('Songs_of_Summer')).toBe('Songs')
  })

  it('drops a trailing year, which is a date and not a name', () => {
    /*
     * The short names are what this is for. A mutation check caught the first
     * version of this test asserting nothing: on
     * `Global_Memes_and_Streamers_2025_2026` the two-word cut already removes
     * the year, so deleting the year rule changed no result. Sheet ⑨ asks for a
     * "trending" category, and `Trending_2026` is the shape that needs it.
     */
    expect(stickerCategoryLabel('12_Trending_2026')).toBe('Trending')
    expect(stickerCategoryLabel('13_Reels_2025_2026')).toBe('Reels')
    expect(stickerCategoryLabel('08_Global_Memes_and_Streamers_2025_2026')).toBe('Global Memes')
  })

  it('keeps every real category distinguishable', () => {
    /*
     * The whole point of the row: two chips reading the same thing is a filter
     * that cannot be used. Checked against the ten categories that actually
     * ship rather than against invented ones.
     */
    const shipped = [
      '01_Telugu_Memes_and_Punchlines', '02_Hindi_Meme_Punchlines',
      '03_Global_Editing_Memes', '05_SpongeBob_Cutaways',
      '06_Epic_Fails_Accidents', '07_Tech_and_Business_Titans',
      '08_Global_Memes_and_Streamers_2025_2026', '09_Indian_Media_and_TV_Debates',
      '10_Indian_Standup_and_Reality_TV', '11_Middle_Eastern_and_Global_Culture'
    ]
    const labels = shipped.map(stickerCategoryLabel)
    expect(new Set(labels).size).toBe(labels.length)
    expect(Math.max(...labels.map((l) => l.length))).toBeLessThanOrEqual(20)
    expect(labels.every((l) => l.length > 0)).toBe(true)
  })

  it('survives a name with nothing in it', () => {
    expect(stickerCategoryLabel('')).toBe('')
    expect(stickerCategoryLabel('07_')).toBe('')
  })
})
