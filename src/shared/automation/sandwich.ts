import type { Clip, Project } from '../timeline'
import { addTrack, clipEnd } from '../timeline'

/**
 * Text behind a person.
 *
 * The compositing order has to be background → text → subject, and a clip is
 * one stream, so the photo is split into TWO ordinary clips: one drawing its
 * background planes, one drawing its subject cutout, with the text on a track
 * between them.
 *
 * Ordinary clips rather than a hidden mode. You can see why the text is behind
 * the subject by looking at the timeline, and you undo it by deleting the front
 * clip — which leaves the background clip still drawing a whole photograph,
 * because a background clip with no front plane above it is just a photo with
 * its subject missing. So `unsandwich` puts it back properly.
 */

export const SANDWICH_RULE = 'sandwich.front'

/** The video clip a text clip is sitting on top of. */
export function subjectClipFor(project: Project, textClip: Clip): Clip | null {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  const textLevel = order.get(textClip.trackId) ?? 0

  const candidates = project.clips.filter((clip) => {
    if (clip.id === textClip.id) return false
    const track = project.tracks.find((t) => t.id === clip.trackId)
    if (!track || track.kind !== 'video') return false
    if ((order.get(clip.trackId) ?? 0) >= textLevel) return false
    if (clip.planes !== undefined) return false
    // Must actually be under the text at some point.
    return clip.start < clipEnd(textClip) && clipEnd(clip) > textClip.start
  })

  // The topmost qualifying clip is the one the text is visually over.
  candidates.sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0))
  return candidates[0] ?? null
}

export interface SandwichResult {
  project: Project
  /** Null when nothing could be done, with `reason` saying why. */
  frontClipId: string | null
  reason?: string
}

/**
 * Split `photo` around `textClip`.
 *
 * The front clip goes on a track above the text, which may mean adding one.
 */
export function sandwich(project: Project, textClip: Clip): SandwichResult {
  const photo = subjectClipFor(project, textClip)
  if (!photo) {
    return { project, frontClipId: null, reason: 'Put the text on a track above a photo first' }
  }

  const bake = project.parallax?.[photo.assetId]
  if (!bake || bake.layers.length < 2) {
    return { project, frontClipId: null, reason: 'Bake depth for that photo first — tick Depth parallax' }
  }
  if (!bake.subject) {
    return {
      project,
      frontClipId: null,
      reason: 'No subject was found in that photo, so there is nothing to go behind'
    }
  }

  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  const textLevel = order.get(textClip.trackId) ?? 0
  const video = project.tracks.filter((t) => t.kind === 'video')
  const above = video.find((t) => (order.get(t.id) ?? 0) > textLevel && !t.locked)

  let next = project
  let targetTrackId = above?.id
  if (!targetTrackId) {
    next = addTrack(next, 'video')
    const added = next.tracks.filter((t) => t.kind === 'video')
    targetTrackId = added[added.length - 1]?.id
    if (!targetTrackId || targetTrackId === photo.trackId) {
      return { project, frontClipId: null, reason: 'No room for another video track' }
    }
  }

  const frontId = `front-${photo.id}-${Date.now().toString(36)}`
  const front: Clip = {
    ...photo,
    id: frontId,
    trackId: targetTrackId,
    planes: 'front',
    // Its own transition would blend the cutout against nothing.
    transitionIn: undefined,
    generatedBy: { rule: SANDWICH_RULE, reason: `subject of ${photo.id}, in front of the text` }
  }

  return {
    project: {
      ...next,
      clips: [
        ...next.clips.map((c) => (c.id === photo.id ? { ...c, planes: 'background' as const } : c)),
        front
      ]
    },
    frontClipId: frontId
  }
}

/** Undo a sandwich: drop the front clip and let the photo draw whole again. */
export function unsandwich(project: Project, frontClipId: string): Project {
  const front = project.clips.find((c) => c.id === frontClipId)
  if (!front) return project

  const backgroundId = project.clips.find(
    (c) => c.assetId === front.assetId && c.planes === 'background' && c.start === front.start
  )?.id

  return {
    ...project,
    clips: project.clips
      .filter((c) => c.id !== frontClipId)
      .map((c) => {
        if (c.id !== backgroundId) return c
        const { planes: _dropped, ...rest } = c
        return rest
      })
  }
}
