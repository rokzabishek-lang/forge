import { describe, it, expect } from 'vitest'
import { sandwich, subjectClipFor, unsandwich, SANDWICH_RULE } from '@shared/automation/sandwich'
import { emptyProject, type Clip, type MediaAsset, type ParallaxBake, type Project } from '@shared/timeline'

const photoAsset: MediaAsset = {
  id: 'img', path: '/p.jpg', name: 'p.jpg', kind: 'image', durationFrames: 90,
  width: 1920, height: 1080, fps: null, hasVideo: true, hasAudio: false, size: 0
}

function bake(over: Partial<ParallaxBake> = {}): ParallaxBake {
  return {
    width: 1920, height: 1080, separated: true, spread: 0.7, subject: true,
    layers: [
      { file: '/b.png', index: 0, depth: 0.1, coverage: 0.7 },
      { file: '/f.png', index: 1, depth: 1, coverage: 0.3 }
    ],
    ...over
  }
}

function scene(over: { bake?: ParallaxBake | null } = {}): { project: Project; text: Clip } {
  const base = emptyProject()
  const v1 = base.tracks.filter((t) => t.kind === 'video')[0]
  const v2 = base.tracks.filter((t) => t.kind === 'video')[1]
  const common = {
    duration: 90, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const photo: Clip = { ...common, id: 'photo', assetId: 'img', trackId: v1.id, start: 0 }
  const text: Clip = { ...common, id: 'text', assetId: 'img', trackId: v2.id, start: 0 }
  const resolved = over.bake === undefined ? bake() : over.bake
  return {
    project: {
      ...base, assets: [photoAsset], clips: [photo, text],
      ...(resolved ? { parallax: { img: resolved } } : {})
    },
    text
  }
}

describe('subjectClipFor', () => {
  it('finds the photo under the text', () => {
    const { project, text } = scene()
    expect(subjectClipFor(project, text)?.id).toBe('photo')
  })

  it('ignores a photo that does not overlap in time', () => {
    const { project, text } = scene()
    const moved = { ...project, clips: project.clips.map((c) => c.id === 'photo' ? { ...c, start: 500 } : c) }
    expect(subjectClipFor(moved, text)).toBeNull()
  })

  it('ignores clips on the text’s own track or above it', () => {
    const { project, text } = scene()
    const sameTrack = {
      ...project,
      clips: project.clips.map((c) => (c.id === 'photo' ? { ...c, trackId: text.trackId } : c))
    }
    expect(subjectClipFor(sameTrack, text)).toBeNull()
  })
})

describe('sandwich', () => {
  it('splits the photo into background and front', () => {
    const { project, text } = scene()
    const result = sandwich(project, text)
    expect(result.frontClipId).toBeTruthy()

    const background = result.project.clips.find((c) => c.id === 'photo')
    const front = result.project.clips.find((c) => c.id === result.frontClipId)
    expect(background?.planes).toBe('background')
    expect(front?.planes).toBe('front')
    expect(front?.assetId).toBe('photo' === front?.assetId ? front?.assetId : 'img')
  })

  it('puts the front clip above the text', () => {
    const { project, text } = scene()
    const result = sandwich(project, text)
    const order = new Map(result.project.tracks.map((t, i) => [t.id, i]))
    const front = result.project.clips.find((c) => c.id === result.frontClipId)!
    expect(order.get(front.trackId)!).toBeGreaterThan(order.get(text.trackId)!)
  })

  it('labels the front clip so it is auditable', () => {
    const { project, text } = scene()
    const front = sandwich(project, text).project.clips.find((c) => c.planes === 'front')
    expect(front?.generatedBy?.rule).toBe(SANDWICH_RULE)
  })

  it('refuses when the photo has no bake', () => {
    const { project, text } = scene({ bake: null })
    const result = sandwich(project, text)
    expect(result.frontClipId).toBeNull()
    expect(result.reason).toMatch(/depth/i)
  })

  it('refuses when the bake found no subject', () => {
    // A depth band is not a person; text behind one looks like a mistake.
    const { project, text } = scene({ bake: bake({ subject: false }) })
    const result = sandwich(project, text)
    expect(result.frontClipId).toBeNull()
    expect(result.reason).toMatch(/subject/i)
  })

  it('leaves the project untouched when it refuses', () => {
    const { project, text } = scene({ bake: null })
    expect(sandwich(project, text).project).toBe(project)
  })

  it('does not re-split an already split photo', () => {
    const { project, text } = scene()
    const once = sandwich(project, text).project
    const again = sandwich(once, text)
    expect(again.frontClipId).toBeNull()
  })
})

describe('unsandwich', () => {
  it('removes the front clip and restores the photo', () => {
    const { project, text } = scene()
    const result = sandwich(project, text)
    const back = unsandwich(result.project, result.frontClipId!)

    expect(back.clips.find((c) => c.id === result.frontClipId)).toBeUndefined()
    // Left as 'background' the photo would render with its subject missing.
    expect(back.clips.find((c) => c.id === 'photo')?.planes).toBeUndefined()
  })

  it('is a no-op for an unknown clip', () => {
    const { project } = scene()
    expect(unsandwich(project, 'nope')).toBe(project)
  })
})
