import { describe, it, expect } from 'vitest'
import {
  fontFamilyFromFilename,
  fontSourceFor,
  isRestrictedFontFile,
  codepointsFromStickerFile,
  charFromCodepoints,
  searchCatalog,
  entriesOfKind,
  findEntry,
  type AssetCatalog
} from '@shared/assets/catalog'

describe('fontFamilyFromFilename', () => {
  it('splits CamelCase Google-Font style names', () => {
    expect(fontFamilyFromFilename('BebasNeue-Regular.ttf')).toBe('Bebas Neue')
    expect(fontFamilyFromFilename('PlayfairDisplay-Bold.ttf')).toBe('Playfair Display')
    expect(fontFamilyFromFilename('LilitaOne-Regular.ttf')).toBe('Lilita One')
  })

  it('leaves already-spaced names alone and drops the weight', () => {
    expect(fontFamilyFromFilename('Arial Bold.ttf')).toBe('Arial')
    expect(fontFamilyFromFilename('Comic Sans MS Bold.ttf')).toBe('Comic Sans MS')
    expect(fontFamilyFromFilename('Trebuchet MS Bold Italic.ttf')).toBe('Trebuchet MS')
  })

  it('handles .ttc collections and restriction suffixes', () => {
    expect(fontFamilyFromFilename('Futura.ttc')).toBe('Futura')
    expect(fontFamilyFromFilename('Dunker_PERSONAL_USE_ONLY.otf')).toBe('Dunker')
  })

  it('keeps single-word names intact', () => {
    expect(fontFamilyFromFilename('Anton-Regular.ttf')).toBe('Anton')
    expect(fontFamilyFromFilename('Impact.ttf')).toBe('Impact')
  })
})

describe('fontSourceFor', () => {
  it('marks OS fonts as system so they are referenced, not shipped', () => {
    expect(fontSourceFor('Arial')).toBe('system')
    expect(fontSourceFor('Impact')).toBe('system')
    expect(fontSourceFor('Futura')).toBe('system')
  })

  it('marks everything else as bundled', () => {
    expect(fontSourceFor('Bebas Neue')).toBe('bundled')
    expect(fontSourceFor('Anton')).toBe('bundled')
  })
})

describe('isRestrictedFontFile', () => {
  it('detects restrictions declared in the filename', () => {
    expect(isRestrictedFontFile('Dunker_PERSONAL_USE_ONLY.otf')).toBe(true)
    expect(isRestrictedFontFile('FirstEncounter_PERSONAL_USE_ONLY.otf')).toBe(true)
    expect(isRestrictedFontFile('Mooligat Demo.otf')).toBe(true)
  })

  it('does not flag ordinary fonts', () => {
    expect(isRestrictedFontFile('Anton-Regular.ttf')).toBe(false)
    // "Demo" must match as a word, not inside another one.
    expect(isRestrictedFontFile('Democratica-Bold.ttf')).toBe(false)
  })
})

describe('sticker codepoints', () => {
  it('parses a single codepoint', () => {
    expect(codepointsFromStickerFile('1F525.svg')).toEqual(['1F525'])
    expect(charFromCodepoints(['1F525'])).toBe('🔥')
  })

  it('parses multi-codepoint sequences such as flags', () => {
    const points = codepointsFromStickerFile('1F1EE-1F1F3.svg')
    expect(points).toEqual(['1F1EE', '1F1F3'])
    expect(charFromCodepoints(points)).toBe('🇮🇳')
  })

  it('ignores non-hex filename parts', () => {
    expect(codepointsFromStickerFile('heart-outline.svg')).toEqual([])
  })

  it('returns empty string for invalid codepoints rather than throwing', () => {
    expect(charFromCodepoints(['ZZZZZZ'])).toBe('')
  })
})

describe('catalog queries', () => {
  const catalog: AssetCatalog = {
    version: 1,
    generatedAt: '2026-09-11T00:00:00.000Z',
    scannedFrom: '/assets',
    entries: [
      { id: 'sfx:whoosh', kind: 'sfx', name: 'fast whoosh', file: 'sfx/w.wav', tags: ['fast', 'whoosh'], meta: { durationMs: 260 } },
      { id: 'sfx:boom', kind: 'sfx', name: '808 sub boom', file: 'sfx/b.wav', tags: ['808', 'sub', 'boom'], meta: { durationMs: 950 } },
      { id: 'font:anton', kind: 'font', name: 'Anton', file: 'fonts/a.ttf', tags: ['Anton', 'bundled'], meta: { family: 'Anton', source: 'bundled' } }
    ]
  }

  it('filters by kind', () => {
    expect(entriesOfKind(catalog, 'sfx')).toHaveLength(2)
    expect(entriesOfKind(catalog, 'title')).toHaveLength(0)
  })

  it('searches name and tags case-insensitively', () => {
    expect(searchCatalog(catalog, 'WHOOSH').map((e) => e.id)).toEqual(['sfx:whoosh'])
    expect(searchCatalog(catalog, '808').map((e) => e.id)).toEqual(['sfx:boom'])
  })

  it('scopes search to a kind', () => {
    expect(searchCatalog(catalog, 'a', 'font').map((e) => e.id)).toEqual(['font:anton'])
  })

  it('returns everything for an empty query', () => {
    expect(searchCatalog(catalog, '   ')).toHaveLength(3)
  })

  it('finds by id and returns null when absent', () => {
    expect(findEntry(catalog, 'sfx:boom')?.name).toBe('808 sub boom')
    expect(findEntry(catalog, 'nope')).toBeNull()
  })
})
