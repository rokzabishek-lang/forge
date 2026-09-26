import type { Project } from './timeline'
import { emptyProject, newProjectId } from './timeline'
import { relativeToProject } from './project/relink'

/**
 * The on-disk project format.
 *
 * Serialization is pure and lives here so it can be tested without touching the
 * filesystem, and so the main process and any future CLI share one definition.
 */

export const SCHEMA_VERSION = 1

/**
 * One recorded director decision.
 *
 * These are persisted as first-class data rather than re-derived by re-running the
 * model. Inference is only reproducible for the same binary on the same hardware
 * with the same backend, so "reopening a project shows the same edit" has to be a
 * property of this file, not of floating-point arithmetic. See docs/DIRECTOR.md §10.3.
 */
export interface DecisionRecord {
  id: string
  /** Which director pass produced this — select | refine | annotate | style. */
  pass: string
  /** The validated op list. Opaque here; the director owns its shape. */
  ops: unknown[]
  /** Stamped so a later model upgrade is visible rather than silent. */
  model: {
    id: string
    quantHash?: string
    runtime?: string
  }
  createdAt: string
  /** Set when the user overrode this decision in the NLE; kept for audit, not applied. */
  reverted?: boolean
}

export interface ProjectFile {
  schemaVersion: number
  app: { name: string; version: string }
  savedAt: string
  project: Project
  decisions: DecisionRecord[]
}

export class ProjectFormatError extends Error {}

export function serializeProject(
  project: Project,
  options: {
    appVersion: string
    decisions?: DecisionRecord[]
    now?: Date
    /**
     * The folder the project file is going into.
     *
     * Given it, each asset underneath it also records where it sits relative
     * to the project — which is what lets the whole folder be moved, or opened
     * on the other machine, and still find its footage.
     */
    projectDir?: string
  } = { appVersion: '0.0.0' }
): ProjectFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: { name: 'Forge', version: options.appVersion },
    savedAt: (options.now ?? new Date()).toISOString(),
    project: {
      ...project,
      assets: project.assets.map((asset) => {
        /*
         * `offline` describes THIS machine right now and is never written.
         *
         * A saved `offline: true` would mark an asset missing on a machine
         * where it is present — and the project would open showing red cards
         * for footage that is sitting right there.
         */
        const { offline: _runtime, ...rest } = asset
        /*
         * Only ADD a relative path; never take one away.
         *
         * `rest` already carries whatever `relativeTo` the asset had, so an
         * autosave — which does not know where the project will end up —
         * simply keeps it. The earlier version fell back to `asset.relativeTo`
         * here, which read as a safeguard and was dead code: the mutation run
         * deleted it and nothing changed, because the spread had already done
         * the job.
         */
        if (!options.projectDir) return rest
        // A converted still travels as the file the user imported, not as its copy in the app's cache.
        const relative = relativeToProject(asset.source ?? asset.path, options.projectDir)
        return relative ? { ...rest, relativeTo: relative } : rest
      })
    },
    decisions: options.decisions ?? []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Migrate an older file forward. Each step is version-to-version so the chain stays
 * readable as the format grows; today there is only one version.
 */
function migrate(file: Record<string, unknown>): Record<string, unknown> {
  const version = file.schemaVersion

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProjectFormatError('This file is missing a usable schema version — it may not be a Forge project')
  }
  if (version > SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `This project was saved by a newer version of Forge (format ${version}, this build reads ${SCHEMA_VERSION})`
    )
  }
  // Future: while (version < SCHEMA_VERSION) apply the next step.
  return file
}

/**
 * Parse and validate. Deliberately strict about structure and lenient about
 * unknown extra fields, so a file written by a newer minor build still opens.
 */
export function deserializeProject(raw: unknown): ProjectFile {
  if (!isRecord(raw)) throw new ProjectFormatError('Project file is not a JSON object')

  const file = migrate(raw)
  const project = file.project

  if (!isRecord(project)) throw new ProjectFormatError('Project file has no project data')
  if (!isRecord(project.settings)) throw new ProjectFormatError('Project is missing its settings')
  if (!Array.isArray(project.tracks)) throw new ProjectFormatError('Project is missing its tracks')
  if (!Array.isArray(project.clips)) throw new ProjectFormatError('Project is missing its clips')
  if (!Array.isArray(project.assets)) throw new ProjectFormatError('Project is missing its media list')

  /*
   * An id for a file that predates them.
   *
   * Minted here rather than left undefined so everything downstream — the
   * autosave key above all — can rely on a project in memory having one. It is
   * written back on the next save, so a file only ever lacks an id once.
   */
  if (typeof project.id !== 'string' || project.id.length === 0) {
    project.id = newProjectId()
  }

  const settings = project.settings as Record<string, unknown>
  for (const key of ['width', 'height', 'fps'] as const) {
    const value = settings[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ProjectFormatError(`Project setting "${key}" is missing or invalid`)
    }
  }

  const defaults = emptyProject()
  const merged: Project = {
    ...defaults,
    ...(project as unknown as Project),
    settings: { ...defaults.settings, ...(settings as unknown as Project['settings']) },
    // Backfilled: projects written before transcripts existed have no such key.
    transcripts:
      typeof project.transcripts === 'object' && project.transcripts !== null
        ? (project.transcripts as Project['transcripts'])
        : {},
    captions:
      typeof project.captions === 'object' && project.captions !== null
        ? { ...defaults.captions, ...(project.captions as Project['captions']) }
        : defaults.captions
  }

  // A clip pointing at a missing asset renders as a hard error later; catching it
  // at load time lets the UI offer a relink instead of failing mid-export.
  const assetIds = new Set(merged.assets.map((a) => a.id))
  const orphans = merged.clips.filter((c) => !assetIds.has(c.assetId))
  if (orphans.length > 0) {
    throw new ProjectFormatError(
      `${orphans.length} clip(s) refer to media that is not in the project: ${orphans
        .map((c) => c.id)
        .slice(0, 5)
        .join(', ')}`
    )
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    app: isRecord(file.app)
      ? { name: String(file.app.name ?? 'Forge'), version: String(file.app.version ?? '0.0.0') }
      : { name: 'Forge', version: '0.0.0' },
    savedAt: typeof file.savedAt === 'string' ? file.savedAt : new Date(0).toISOString(),
    project: merged,
    decisions: Array.isArray(file.decisions) ? (file.decisions as DecisionRecord[]) : []
  }
}
