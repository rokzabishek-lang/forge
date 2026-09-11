import { describe, it, expect } from 'vitest'
import { fontFamilies, searchEntries } from '@shared/assets/catalog'
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
