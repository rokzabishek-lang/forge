import type { Project } from '../timeline'
import type { Measure } from './gate'
import type { Look, StoredLook } from './look'
import type { Slot } from './menu'

/**
 * What the Director's eyes know about each photo, and when to look again
 * (docs/PLAN.md §4.1–4.2).
 *
 * Two kinds of seeing, each cached on the project by the file's `size:mtime`
 * key: the sidecar's measurement (cheap, arithmetic) and the VLM's look (a
 * model call per photo, seconds each on a CPU). A retry never looks twice; a
 * photo replaced by a different file of the same name is looked at afresh,
 * because its key changed and the old answers go with it.
 *
 * These are facts about the photos, not the Director's work, so
 * `clearDirector` leaves them alone.
 */

export interface AssetVision {
  /** The file's `size:mtime` when it was measured and looked at. */
  key: string
  measure?: Measure
  look?: StoredLook
}

/**
 * Does this photo need measuring? Not when its measurement is for this very
 * file — unless it was measured before `backdropClip` existed (2026-09-26), in
 * which case a white-backdrop photo would stay flagged blown for as long as
 * the file is unchanged. A file that cannot be read cannot be measured.
 */
export function needsMeasure(vision: AssetVision | undefined, key: string | null): boolean {
  if (key === null) return false
  return !vision || vision.key !== key || !vision.measure || vision.measure.backdropClip === undefined
}

/** Does this photo need looking at? Same rule; a look by an earlier model is still a look. */
export function needsLook(vision: AssetVision | undefined, key: string | null): boolean {
  if (key === null) return false
  return !vision || vision.key !== key || !vision.look
}

/**
 * The project with one photo's vision updated.
 *
 * A different key means a different file: whatever was known about the old
 * one is dropped, not merged, so a measurement of one picture can never sit
 * beside a look at another.
 */
export function withVision(project: Project, assetId: string, key: string, patch: { measure?: Measure; look?: StoredLook }): Project {
  const current = project.vision?.[assetId]
  const base: AssetVision = current && current.key === key ? current : { key }
  return { ...project, vision: { ...(project.vision ?? {}), [assetId]: { ...base, ...patch } } }
}

/** The looks and measurements the gate reads, for the slots on offer, keyed by asset id. */
export function eyesOf(project: Project, slots: Slot[]): { looks: Record<string, Look>; measures: Record<string, Measure> } {
  const looks: Record<string, Look> = {}
  const measures: Record<string, Measure> = {}
  for (const s of slots) {
    const v = project.vision?.[s.assetId]
    if (v?.look) {
      const { key: _k, model: _m, at: _a, ...look } = v.look
      looks[s.assetId] = look
    }
    if (v?.measure) measures[s.assetId] = v.measure
  }
  return { looks, measures }
}
