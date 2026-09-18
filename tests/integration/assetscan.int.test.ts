import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
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

describe('a root with installed packs under it', () => {
  let packs = ''

  beforeAll(async () => {
    /*
     * The shape `installPack` actually leaves: `<root>/<pack.id>/<kind>/…`.
     *
     * This was a real bug, and the bad kind — the download succeeded, the files
     * were on disk, the receipt was written, and the Library said "Nothing
     * here." Scanning only the root could never see a single one of them.
     */
    packs = await mkdtemp(join(tmpdir(), 'forge-assets-packs-'))
    await mkdir(join(packs, 'library', 'fonts'), { recursive: true })
    await mkdir(join(packs, 'stickers-telugu', 'color', 'svg'), { recursive: true })
    await mkdir(join(packs, 'stickers-hindi', 'color', 'svg'), { recursive: true })
    await mkdir(join(packs, '.packs'), { recursive: true })
    await mkdir(join(packs, '.library.installing', 'fonts'), { recursive: true })

    await writeFile(join(packs, 'library', 'fonts', 'BebasNeue-Regular.ttf'), 'x')
    await writeFile(join(packs, 'stickers-telugu', 'color', 'svg', '1F525.svg'), '<svg/>')
    await writeFile(join(packs, 'stickers-hindi', 'color', 'svg', '1F680.svg'), '<svg/>')
    await writeFile(join(packs, '.packs', 'library.json'), '{}')
    await writeFile(join(packs, '.library.installing', 'fonts', 'Half-Written.ttf'), 'x')
  })

  afterAll(async () => {
    await rm(packs, { recursive: true, force: true }).catch(() => undefined)
  })

  it('finds what a pack installed, one directory down', async () => {
    const fonts = entriesOfKind(await scanAssets(packs), 'font')
    expect(fonts).toHaveLength(1)
    expect(fonts[0].file).toBe('library/fonts/BebasNeue-Regular.ttf')
  })

  it('unions two packs of the same kind, which is what categories are', async () => {
    // Someone with Telugu and Hindi installed has one sticker drawer, not two.
    const stickers = entriesOfKind(await scanAssets(packs), 'sticker')
    expect(stickers.map((s) => s.name).sort()).toEqual(['🔥', '🚀'])
  })

  it('ignores the receipts folder and a crashed install, not just the files in them', async () => {
    /*
     * A staging directory is the one thing `installPack`'s cleanup cannot
     * remove — a crash mid-unpack leaves it. Catalogued, it would be a second,
     * partial copy of everything in the pack. It is named with a leading dot so
     * the same rule that skips `.packs` skips it too.
     */
    const catalog = await scanAssets(packs)
    expect(catalog.entries.map((e) => e.file)).not.toContain(
      '.library.installing/fonts/Half-Written.ttf'
    )
    expect(catalog.entries.some((e) => e.file.includes('.packs'))).toBe(false)
  })
})

describe('clip stickers, described by the pack index', () => {
  let clips = ''

  beforeAll(async () => {
    /*
     * A keyed cut-out is a PAIR of files — H.264 4:2:0 cannot carry alpha — and
     * its title, duration and loop behaviour are decided once when the pack is
     * built. None of that can be read back from a filename, so the pack ships
     * an index.json and the scan reads it.
     */
    clips = await mkdtemp(join(tmpdir(), 'forge-assets-clips-'))
    const dir = join(clips, 'stickers-telugu', 'stickers')
    await mkdir(dir, { recursive: true })
    for (const name of ['reaction-107.colour.mp4', 'reaction-107.matte.mp4', 'reaction-107.thumb.webp', 'wow.colour.mp4', 'wow.matte.mp4']) {
      await writeFile(join(dir, name), 'x')
    }
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        category: '01_Telugu_Memes_and_Punchlines',
        stickers: [
          {
            key: 'reaction-107', title: 'Telugu Comedy Reaction Hook 107',
            colour: 'reaction-107.colour.mp4', matte: 'reaction-107.matte.mp4',
            thumb: 'reaction-107.thumb.webp',
            width: 512, height: 294, durationMs: 4900, loops: false, hasAudio: true
          },
          {
            key: 'wow', title: 'Wow', colour: 'wow.colour.mp4', matte: 'wow.matte.mp4',
            width: 300, height: 300, durationMs: 1200, loops: true, hasAudio: false
          }
        ]
      })
    )
    // An emoji pack alongside, because both shapes live in the same drawer.
    const emoji = join(clips, 'library', 'color', 'svg')
    await mkdir(emoji, { recursive: true })
    await writeFile(join(emoji, '1F525.svg'), '<svg/>')
  })

  afterAll(async () => {
    await rm(clips, { recursive: true, force: true }).catch(() => undefined)
  })

  it('reads a clip sticker with everything the timeline needs', async () => {
    const stickers = entriesOfKind(await scanAssets(clips), 'sticker')
    const reaction = stickers.find((s) => s.name.includes('Reaction Hook'))!
    expect(reaction).toBeDefined()
    expect(reaction.file).toBe('stickers-telugu/stickers/reaction-107.colour.mp4')
    expect(reaction.meta).toEqual({
      form: 'clip',
      matte: 'stickers-telugu/stickers/reaction-107.matte.mp4',
      thumb: 'stickers-telugu/stickers/reaction-107.thumb.webp',
      width: 512,
      height: 294,
      durationMs: 4900,
      loops: false,
      hasAudio: true
    })
  })

  it('carries the loop decision through, so the app never has to ask', async () => {
    // Stretching a 2s reaction across a 30s clip plays it at 1/15 speed, and
    // with a meme the timing is the joke. One-shot or loop, decided at build.
    const stickers = entriesOfKind(await scanAssets(clips), 'sticker')
    expect(stickers.find((s) => s.name === 'Wow')!.meta).toMatchObject({ loops: true })
    expect(stickers.find((s) => s.name.includes('Reaction'))!.meta).toMatchObject({ loops: false })
  })

  it('keeps emoji and clips in the same drawer, told apart by form', async () => {
    const stickers = entriesOfKind(await scanAssets(clips), 'sticker')
    expect(stickers).toHaveLength(3)
    expect(stickers.filter((s) => (s.meta as { form: string }).form === 'clip')).toHaveLength(2)
    const emoji = stickers.find((s) => (s.meta as { form: string }).form === 'emoji')!
    expect(emoji.name).toBe('🔥')
  })

  it('gives each clip a distinct id, even with the same filename in two packs', async () => {
    /*
     * Ids come from the relative path, not the key. Two category packs are very
     * likely to both contain a `wow`, and duplicate ids mean the wrong sticker
     * comes back from a lookup.
     */
    const second = join(clips, 'stickers-hindi', 'stickers')
    await mkdir(second, { recursive: true })
    await writeFile(join(second, 'wow.colour.mp4'), 'x')
    await writeFile(join(second, 'wow.matte.mp4'), 'x')
    await writeFile(join(second, 'index.json'), JSON.stringify({
      version: 1, category: '02_Hindi', stickers: [{
        key: 'wow', title: 'Wow', colour: 'wow.colour.mp4', matte: 'wow.matte.mp4',
        width: 100, height: 100, durationMs: 900, loops: false, hasAudio: false
      }]
    }))

    const stickers = entriesOfKind(await scanAssets(clips), 'sticker')
    const ids = stickers.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    await rm(join(clips, 'stickers-hindi'), { recursive: true, force: true })
  })

  it('refuses an index that names a file outside its own directory', async () => {
    const dir = join(clips, 'stickers-telugu', 'stickers')
    const good = await readFile(join(dir, 'index.json'), 'utf8')
    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: 1, category: 'x', stickers: [{
        key: 'escape', title: 'Escape', colour: '../../../etc/passwd', matte: 'a.matte.mp4',
        width: 10, height: 10, durationMs: 1, loops: false, hasAudio: false
      }]
    }))
    const stickers = entriesOfKind(await scanAssets(clips), 'sticker')
    expect(stickers.some((s) => s.file.includes('passwd'))).toBe(false)
    await writeFile(join(dir, 'index.json'), good)
  })

  it('loses one pack to a corrupt index, not the whole catalog', async () => {
    const dir = join(clips, 'stickers-telugu', 'stickers')
    const good = await readFile(join(dir, 'index.json'), 'utf8')
    await writeFile(join(dir, 'index.json'), '{ not json at all')
    const catalog = await scanAssets(clips)
    // The emoji in the other pack is untouched.
    expect(entriesOfKind(catalog, 'sticker').map((s) => s.name)).toEqual(['🔥'])
    await writeFile(join(dir, 'index.json'), good)
  })
})

describe('sounds a pack has named for itself', () => {
  let sounds = ''

  beforeAll(async () => {
    sounds = await mkdtemp(join(tmpdir(), 'forge-assets-sfx-'))
    const pack = join(sounds, 'sfx-meme-sounds', 'sfx')
    await mkdir(pack, { recursive: true })
    await writeFile(join(pack, '001-collect-item.m4a'), 'x')
    await writeFile(join(pack, '002-bass-drop-vine-boom.m4a'), 'x')
    await writeFile(join(pack, 'index.json'), JSON.stringify({
      version: 1,
      sfx: [
        { key: '001-collect-item', title: 'Collect Item', file: '001-collect-item.m4a', durationMs: 1200 },
        { key: '002-bass-drop-vine-boom', title: 'Bass Drop + Vine Boom', file: '002-bass-drop-vine-boom.m4a', durationMs: 2400 }
      ]
    }))
    // A hand-placed library with no index, whose names must be left alone.
    await mkdir(join(sounds, 'sfx'), { recursive: true })
    await writeFile(join(sounds, 'sfx', '808_boom.wav'), 'x')
  })

  afterAll(async () => {
    await rm(sounds, { recursive: true, force: true }).catch(() => undefined)
  })

  it('uses the title the pack states, not the numbered filename', async () => {
    const sfx = entriesOfKind(await scanAssets(sounds), 'sfx')
    expect(sfx.map((s) => s.name)).toContain('Collect Item')
    expect(sfx.map((s) => s.name)).toContain('Bass Drop + Vine Boom')
    expect(sfx.map((s) => s.name)).not.toContain('001 collect item')
  })

  it('leaves a library with no index exactly as it was', async () => {
    /*
     * The tempting fix was to strip a leading number in the fallback, which
     * would rename `808 boom` to `boom`. An index prefix and a name that starts
     * with digits are indistinguishable by looking, so only a pack that states
     * a title gets one.
     */
    const sfx = entriesOfKind(await scanAssets(sounds), 'sfx')
    expect(sfx.map((s) => s.name)).toContain('808 boom')
  })

  it('takes the duration from the index instead of leaving it null', async () => {
    const sfx = entriesOfKind(await scanAssets(sounds), 'sfx')
    expect(sfx.find((s) => s.name === 'Collect Item')!.meta).toEqual({ durationMs: 1200 })
    // Unknown stays null rather than being invented.
    expect(sfx.find((s) => s.name === '808 boom')!.meta).toEqual({ durationMs: null })
  })
})

describe('sticker thumbnails', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'forge-assets-thumb-'))
    const pack = join(dir, 'stickers-x', 'stickers')
    await mkdir(pack, { recursive: true })
    for (const n of ['a.colour.mp4', 'a.matte.mp4', 'a.thumb.webp', 'b.colour.mp4', 'b.matte.mp4']) {
      await writeFile(join(pack, n), 'x')
    }
    await writeFile(join(pack, 'index.json'), JSON.stringify({
      version: 1, category: 'x',
      stickers: [
        { key: 'a', title: 'With thumb', colour: 'a.colour.mp4', matte: 'a.matte.mp4', thumb: 'a.thumb.webp', width: 100, height: 100, durationMs: 900, loops: false, hasAudio: false },
        { key: 'b', title: 'No thumb', colour: 'b.colour.mp4', matte: 'b.matte.mp4', width: 100, height: 100, durationMs: 900, loops: false, hasAudio: false },
        { key: 'c', title: 'Escaping thumb', colour: 'a.colour.mp4', matte: 'a.matte.mp4', thumb: '../../secrets.webp', width: 100, height: 100, durationMs: 900, loops: false, hasAudio: false }
      ]
    }))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('carries the thumbnail path through, since the grid draws with an img', async () => {
    /*
     * A clip sticker is an mp4 and the Library grid uses <img>. Without a still
     * the whole drawer is blank tiles — the pack installs, the catalog is
     * right, and the user sees nothing.
     */
    const stickers = entriesOfKind(await scanAssets(dir), 'sticker')
    expect(stickers.find((s) => s.name === 'With thumb')!.meta).toMatchObject({
      thumb: 'stickers-x/stickers/a.thumb.webp'
    })
  })

  it('leaves the field off entirely when a pack ships no thumbnail', async () => {
    // An older pack has none, and the tile has to fall back rather than point
    // at a file that is not there.
    const stickers = entriesOfKind(await scanAssets(dir), 'sticker')
    expect(stickers.find((s) => s.name === 'No thumb')!.meta).not.toHaveProperty('thumb')
  })

  it('refuses a thumbnail that points outside its own directory', async () => {
    const stickers = entriesOfKind(await scanAssets(dir), 'sticker')
    const escaping = stickers.find((s) => s.name === 'Escaping thumb')!
    expect(escaping.meta).not.toHaveProperty('thumb')
  })
})
