import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAssets, catalogSummary } from '../../src/main/assets/scan'
import { entriesOfKind, searchCatalog, type FontMeta } from '@shared/assets/catalog'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-assets-'))
  await mkdir(join(root, 'fonts'), { recursive: true })
  await mkdir(join(root, 'sfx'), { recursive: true })
  await mkdir(join(root, 'stickers', 'color', 'svg'), { recursive: true })
  await mkdir(join(root, 'props_3d'), { recursive: true })
  await mkdir(join(root, 'titles'), { recursive: true })
  await mkdir(join(root, 'transitions', 'extra'), { recursive: true })

  await writeFile(join(root, 'fonts', 'BebasNeue-Regular.ttf'), 'x')
  await writeFile(join(root, 'fonts', 'Arial Bold.ttf'), 'x')
  await writeFile(join(root, 'fonts', 'Dunker_PERSONAL_USE_ONLY.otf'), 'x')
  await writeFile(join(root, 'fonts', 'notafont.txt'), 'x')
  await writeFile(join(root, 'sfx', 'fast_whoosh.wav'), 'x')
  await writeFile(join(root, 'stickers', 'color', 'svg', '1F525.svg'), '<svg/>')
  await writeFile(join(root, 'props_3d', 'rocket_3d.png'), 'x')
  await writeFile(
    join(root, 'titles', 'Gold_Top.svg'),
    '<svg width="1920" height="1080"><text>a</text><text>b</text></svg>'
  )
  await writeFile(join(root, 'transitions', 'extra', 'barr_ripple_1.jpg'), 'x')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

describe('scanAssets', () => {
  it('classifies every asset kind', async () => {
    const catalog = await scanAssets(root)
    expect(entriesOfKind(catalog, 'font')).toHaveLength(3)
    expect(entriesOfKind(catalog, 'sfx')).toHaveLength(1)
    expect(entriesOfKind(catalog, 'sticker')).toHaveLength(1)
    expect(entriesOfKind(catalog, 'prop')).toHaveLength(1)
    expect(entriesOfKind(catalog, 'title')).toHaveLength(1)
    expect(entriesOfKind(catalog, 'transition')).toHaveLength(1)
  })

  it('ignores files that are not assets', async () => {
    const catalog = await scanAssets(root)
    expect(catalog.entries.some((e) => e.file.endsWith('notafont.txt'))).toBe(false)
  })

  it('separates system fonts from bundled ones', async () => {
    const fonts = entriesOfKind(await scanAssets(root), 'font')
    const arial = fonts.find((f) => (f.meta as FontMeta).family === 'Arial')!
    const bebas = fonts.find((f) => (f.meta as FontMeta).family === 'Bebas Neue')!
    expect((arial.meta as FontMeta).source).toBe('system')
    expect((bebas.meta as FontMeta).source).toBe('bundled')
  })

  it('flags fonts whose filename declares a restriction', async () => {
    const fonts = entriesOfKind(await scanAssets(root), 'font')
    const dunker = fonts.find((f) => (f.meta as FontMeta).family === 'Dunker')!
    expect((dunker.meta as FontMeta).restricted).toBe(true)
  })

  it('stores paths relative to the root, so the library can move', async () => {
    const catalog = await scanAssets(root)
    for (const entry of catalog.entries) {
      expect(entry.file.startsWith('/')).toBe(false)
      expect(entry.file).not.toContain(root)
    }
  })

  it('decodes sticker codepoints into characters for search', async () => {
    const catalog = await scanAssets(root)
    expect(searchCatalog(catalog, '🔥', 'sticker')).toHaveLength(1)
  })

  it('reads title canvas size and counts editable text slots', async () => {
    const title = entriesOfKind(await scanAssets(root), 'title')[0]
    expect(title.meta).toMatchObject({ width: 1920, height: 1080, textSlots: 2 })
  })

  it('returns an empty catalog for a missing root rather than throwing', async () => {
    const catalog = await scanAssets(join(root, 'does-not-exist'))
    expect(catalog.entries).toEqual([])
  })

  it('summarises what was found, so an empty kind is visible', async () => {
    expect(catalogSummary(await scanAssets(root))).toMatchObject({
      font: 3, sfx: 1, sticker: 1, prop: 1, title: 1, transition: 1
    })
  })
})

describe('directory aliases', () => {
  let alt = ''

  beforeAll(async () => {
    // A real library arrived using 'sfxx' and a top-level 'color' instead of
    // 'sfx' and 'stickers'. The scan must cope without the library being
    // reorganised first.
    alt = await mkdtemp(join(tmpdir(), 'forge-assets-alt-'))
    await mkdir(join(alt, 'sfxx'), { recursive: true })
    await mkdir(join(alt, 'color', 'svg'), { recursive: true })
    await writeFile(join(alt, 'sfxx', 'cinematic_boom.wav'), 'x')
    await writeFile(join(alt, 'color', 'svg', '1F680.svg'), '<svg/>')
  })

  afterAll(async () => {
    await rm(alt, { recursive: true, force: true }).catch(() => undefined)
  })

  it('finds sfx under an aliased folder name', async () => {
    const sfx = entriesOfKind(await scanAssets(alt), 'sfx')
    expect(sfx).toHaveLength(1)
    expect(sfx[0].name).toBe('cinematic boom')
  })

  it('finds stickers whether they sit under stickers/ or color/', async () => {
    const stickers = entriesOfKind(await scanAssets(alt), 'sticker')
    expect(stickers).toHaveLength(1)
    expect(stickers[0].name).toBe('🚀')
  })
})
