import { describe, it, expect } from 'vitest'
import {
  baseNameOf,
  dirNameOf,
  joinPath,
  relativeToProject,
  candidatePaths,
  matchByName,
  applyRelink,
  offlineAssets
} from '@shared/project/relink'
import { serializeProject } from '@shared/project'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a', path: '/work/ad/clips/shot.mp4', name: 'shot.mp4', kind: 'video',
  durationFrames: 300, width: 1920, height: 1080, fps: 30,
  hasVideo: true, hasAudio: true, size: 5_000_000, ...over
})

describe('paths, on both platforms at once', () => {
  it('splits on either separator', () => {
    expect(baseNameOf('/a/b/c.mp4')).toBe('c.mp4')
    expect(baseNameOf('C:\\a\\b\\c.mp4')).toBe('c.mp4')
    expect(baseNameOf('c.mp4')).toBe('c.mp4')
    expect(dirNameOf('/a/b/c.mp4')).toBe('/a/b')
    expect(dirNameOf('C:\\a\\b\\c.mp4')).toBe('C:\\a\\b')
    expect(dirNameOf('c.mp4')).toBe('')
  })

  it('joins the way the ROOT would, not the way this machine would', () => {
    /*
     * A project written on Windows and opened on a Mac carries Windows roots.
     * Deciding from the shape of the root rather than from `process.platform`
     * is the same rule `assetPath` uses — and a POSIX filename is allowed to
     * contain a backslash, so guessing from the characters would mangle it.
     */
    expect(joinPath('/work/ad', 'clips/shot.mp4')).toBe('/work/ad/clips/shot.mp4')
    expect(joinPath('C:\\work\\ad', 'clips/shot.mp4')).toBe('C:\\work\\ad\\clips\\shot.mp4')
    expect(joinPath('\\\\server\\share', 'a/b.mp4')).toBe('\\\\server\\share\\a\\b.mp4')
    expect(joinPath('/work/ad/', 'shot.mp4')).toBe('/work/ad/shot.mp4')
    expect(joinPath('', 'shot.mp4')).toBe('shot.mp4')
  })
})

describe('where an asset sits relative to its project', () => {
  it('is expressed when the asset is under the project folder', () => {
    expect(relativeToProject('/work/ad/clips/shot.mp4', '/work/ad')).toBe('clips/shot.mp4')
    expect(relativeToProject('C:\\work\\ad\\clips\\shot.mp4', 'C:\\work\\ad')).toBe(
      'clips/shot.mp4'
    )
  })

  it('is not expressed for anything outside it', () => {
    /*
     * `../../..` segments stop meaning anything the moment either end moves,
     * so those assets keep their absolute path alone and rely on relinking.
     */
    expect(relativeToProject('/elsewhere/shot.mp4', '/work/ad')).toBeNull()
    // A sibling folder whose name merely STARTS with the project's.
    expect(relativeToProject('/work/adverts/shot.mp4', '/work/ad')).toBeNull()
    expect(relativeToProject('/work/ad', '/work/ad')).toBeNull()
    expect(relativeToProject('/work/ad/shot.mp4', '')).toBeNull()
  })
})

describe('where to look for a file', () => {
  it('tries absolute first', () => {
    // On the machine that made the project it is simply right, and anything
    // else first would find a same-named file in the wrong folder.
    const paths = candidatePaths(asset(), '/other/place', ['/library'])
    expect(paths[0]).toBe('/work/ad/clips/shot.mp4')
  })

  it('then relative to the project, then the folders it already knows', () => {
    const paths = candidatePaths(
      asset({ relativeTo: 'clips/shot.mp4' }),
      '/moved/ad',
      ['/library/footage']
    )
    expect(paths).toEqual([
      '/work/ad/clips/shot.mp4',
      '/moved/ad/clips/shot.mp4',
      '/library/footage/shot.mp4'
    ])
  })

  it('does not stat the same place twice', () => {
    // The stat per candidate is the expensive part, and a project sitting
    // beside its footage produces the same path twice.
    const paths = candidatePaths(asset({ relativeTo: 'clips/shot.mp4' }), '/work/ad', [
      '/work/ad/clips'
    ])
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('matching missing assets to files', () => {
  it('matches by name, which is what makes a folder relink work', () => {
    const found = matchByName(
      [
        { id: 'a', path: '/old/shot.mp4', size: 100 },
        { id: 'b', path: '/old/music.m4a', size: 200 }
      ],
      [
        { path: '/new/shot.mp4', size: 100 },
        { path: '/new/music.m4a', size: 999 }
      ]
    )
    // Size does not have to match when the name is unambiguous: a re-encode is
    // still the take the edit was cut against.
    expect(found).toEqual({ a: '/new/shot.mp4', b: '/new/music.m4a' })
  })

  it('uses size to break a tie between duplicates', () => {
    /*
     * `IMG_0001.MOV` is the most common filename in the world, and a folder of
     * footage from two cameras has several.
     */
    const found = matchByName(
      [{ id: 'a', path: '/old/IMG_0001.MOV', size: 200 }],
      [
        { path: '/new/camA/IMG_0001.MOV', size: 100 },
        { path: '/new/camB/IMG_0001.MOV', size: 200 }
      ]
    )
    expect(found).toEqual({ a: '/new/camB/IMG_0001.MOV' })
  })

  it('leaves an ambiguous asset ALONE rather than guessing', () => {
    /*
     * A wrongly relinked clip is worse than an offline one: it renders, it
     * looks plausible, and nothing says it is the wrong take.
     */
    const found = matchByName(
      [{ id: 'a', path: '/old/IMG_0001.MOV', size: 555 }],
      [
        { path: '/new/camA/IMG_0001.MOV', size: 100 },
        { path: '/new/camB/IMG_0001.MOV', size: 200 }
      ]
    )
    expect(found).toEqual({})
  })

  it('does not let a zero-size asset match the one empty file among several', () => {
    /*
     * `size` is 0 for assets this app drew itself, and a 0-byte FILE is an
     * empty or truncated one. Without the guard those two zeroes match each
     * other and the relink points a text card at a broken file — which then
     * renders as nothing, with the offline mark cleared so nothing says why.
     *
     * Two same-size candidates cannot show this: they are ambiguous either
     * way. It takes exactly one zero-byte file among several, which is what
     * the mutation run needed and the first version of this test did not have.
     */
    const found = matchByName(
      [{ id: 'a', path: '/old/card.png', size: 0 }],
      [
        { path: '/new/one/card.png', size: 0 },
        { path: '/new/two/card.png', size: 4096 }
      ]
    )
    expect(found).toEqual({})
  })

  it('matches a name whose case differs, because Windows does', () => {
    const found = matchByName(
      [{ id: 'a', path: '/old/Shot.MP4', size: 1 }],
      [{ path: '/new/shot.mp4', size: 1 }]
    )
    expect(found).toEqual({ a: '/new/shot.mp4' })
  })
})

describe('applying a relink', () => {
  const project = (assets: MediaAsset[], clips: Clip[] = []): Project => ({
    ...emptyProject(),
    assets,
    clips
  })

  it('repoints the asset and clears its offline mark', () => {
    const before = project([asset({ offline: true })])
    const after = applyRelink(before, { a: '/found/shot.mp4' })
    expect(after.assets[0].path).toBe('/found/shot.mp4')
    expect(after.assets[0].offline).toBeUndefined()
    // Cleared rather than set false: a false would be serialised noise.
    expect('offline' in after.assets[0]).toBe(false)
  })

  it('leaves assets it was not asked about alone', () => {
    const before = project([asset(), asset({ id: 'b', path: '/other.mp4' })])
    const after = applyRelink(before, { a: '/found/shot.mp4' })
    expect(after.assets[1].path).toBe('/other.mp4')
    expect(applyRelink(before, {})).toBe(before)
  })
})

describe('refusing an export that would fail', () => {
  const clip = (assetId: string): Clip => ({
    id: `c-${assetId}`, assetId, trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })

  it('names the missing files a clip actually uses', () => {
    const p: Project = {
      ...emptyProject(),
      assets: [asset({ id: 'used', offline: true }), asset({ id: 'fine' })],
      clips: [clip('used'), clip('fine')]
    }
    expect(offlineAssets(p).map((a) => a.id)).toEqual(['used'])
  })

  it('ignores a missing file nothing references', () => {
    /*
     * A stale pool entry does not affect the render at all, and refusing over
     * it would be an export blocked by something invisible in the output.
     */
    const p: Project = {
      ...emptyProject(),
      assets: [asset({ id: 'unused', offline: true }), asset({ id: 'fine' })],
      clips: [clip('fine')]
    }
    expect(offlineAssets(p)).toEqual([])
  })
})

describe('what reaches the project file', () => {
  it('records where each asset sits relative to the project', () => {
    const p: Project = {
      ...emptyProject(),
      assets: [asset(), asset({ id: 'b', path: '/elsewhere/other.mp4' })]
    }
    const file = serializeProject(p, { appVersion: '1.0.0', projectDir: '/work/ad' })
    expect(file.project.assets[0].relativeTo).toBe('clips/shot.mp4')
    // Outside the project folder, so no relative path is claimed.
    expect(file.project.assets[1].relativeTo).toBeUndefined()
  })

  it('never writes the offline mark', () => {
    /*
     * It describes THIS machine at this moment. A saved `offline: true` would
     * mark an asset missing on a machine where it is present, and the project
     * would open showing red cards for footage sitting right there.
     */
    const p: Project = { ...emptyProject(), assets: [asset({ offline: true })] }
    const file = serializeProject(p, { appVersion: '1.0.0', projectDir: '/work/ad' })
    expect('offline' in file.project.assets[0]).toBe(false)
    expect(JSON.stringify(file)).not.toContain('offline')
  })

  it('keeps a relative path it was given when it is not told the folder', () => {
    // Autosave does not know where the project will end up; it must not drop
    // the relative paths a real save already worked out.
    const p: Project = { ...emptyProject(), assets: [asset({ relativeTo: 'clips/shot.mp4' })] }
    const file = serializeProject(p, { appVersion: '1.0.0' })
    expect(file.project.assets[0].relativeTo).toBe('clips/shot.mp4')
  })
})

describe('a converted still travels as the file it was made from', () => {
  /*
   * An AVIF or HEIC is read through a PNG in the app's cache (main/imports.ts):
   * `path` is the copy, `source` the file the user imported. Everything that
   * moves a project follows the file, never the copy — the copy is not under
   * the project, does not exist on the other machine, and is remade on open.
   */
  const converted = asset({ id: 'c', path: '/Users/me/Library/Forge/converted/123-456-photo2.png', source: '/work/ad/photos/photo2.avif', name: 'photo2.avif', kind: 'image', size: 240_000 })

  it('is looked for as its source: absolute, relative to the project, then in the known folders — never as its copy', () => {
    const where = candidatePaths({ ...converted, relativeTo: 'photos/photo2.avif' }, '/moved/ad', ['/drive/photos'])
    expect(where).toEqual(['/work/ad/photos/photo2.avif', '/moved/ad/photos/photo2.avif', '/drive/photos/photo2.avif'])
    expect(where.some((p) => p.endsWith('.png'))).toBe(false)
  })

  it('is matched to a folder by the source’s name and size', () => {
    const found = matchByName(
      [{ id: 'c', path: converted.path, size: converted.size, source: converted.source }],
      [
        { path: '/drive/photos/photo2.avif', size: 240_000 },
        { path: '/drive/photos/123-456-photo2.png', size: 999 }
      ]
    )
    expect(found).toEqual({ c: '/drive/photos/photo2.avif' })
  })

  it('is saved with a relative path to the source, so the project finds it on the other machine', () => {
    const file = serializeProject({ ...emptyProject(), assets: [converted] }, { appVersion: '1.0.0', projectDir: '/work/ad' })
    expect(file.project.assets[0].relativeTo).toBe('photos/photo2.avif')
    expect(file.project.assets[0].source).toBe('/work/ad/photos/photo2.avif')
  })

  it('a relink hands back the copy to read and the file it came from; relinked to a plain file, the source goes', () => {
    const before: Project = { ...emptyProject(), assets: [{ ...converted, offline: true }] }
    const again = applyRelink(before, { c: { path: '/cache/789-photo2.png', source: '/drive/photos/photo2.avif' } })
    expect(again.assets[0]).toMatchObject({ path: '/cache/789-photo2.png', source: '/drive/photos/photo2.avif' })
    expect('offline' in again.assets[0]).toBe(false)
    const plain = applyRelink(before, { c: '/drive/photos/photo2.jpg' })
    expect(plain.assets[0].path).toBe('/drive/photos/photo2.jpg')
    expect('source' in plain.assets[0]).toBe(false)
  })
})
