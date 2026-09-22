/**
 * Autosave and recovery — deciding what is worth offering back.
 *
 * Nothing in this app saved by itself. Close the window and everything since
 * the last ⌘S was gone, with no prompt, no autosave and no way back — and
 * there was no `close` handler at all, so the window simply went. For an
 * editor where one session is an hour of decisions, that is the most expensive
 * bug in the list even though it is the least visible.
 *
 * The rules here are the ones that decide whether a recovery is offered, kept
 * away from the filesystem so they can be tested as rules. Everything they
 * decide about is a FILE, and the one thing worse than losing an hour's work
 * is being offered a stale copy of it and taking it.
 */

export interface AutosaveRecord {
  /** The project this autosave belongs to. */
  projectId: string
  /** Where the autosave was written. */
  file: string
  /** When it was written, in epoch milliseconds. */
  savedAt: number
  /** The project's real file, if it had one. */
  projectPath: string | null
  /** When that real file was last written, if it exists. */
  projectSavedAt: number | null
  name: string
}

/**
 * Autosaves worth offering, newest first.
 *
 * Offered only when the autosave is NEWER than the saved file — otherwise it
 * holds work the user has already saved over, and restoring it would undo the
 * save rather than recover from a crash. A project that was never saved has no
 * file to compare against, so any autosave of it is worth offering: there is
 * nothing else.
 *
 * The margin matters. Saving writes the real file and then, a moment later, the
 * autosave timer may fire; without a tolerance, every ordinary save would leave
 * an "autosave is newer" recovery waiting at the next launch, and a recovery
 * prompt that appears every single time is one nobody reads.
 */
export const RECOVERY_MARGIN_MS = 5_000

export function worthRecovering(records: AutosaveRecord[]): AutosaveRecord[] {
  return records
    .filter((record) => {
      if (record.projectSavedAt === null) return true
      return record.savedAt - record.projectSavedAt > RECOVERY_MARGIN_MS
    })
    .sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * The autosave file's name for a project.
 *
 * Keyed by the project's own id rather than by its path: a project saved under
 * a new name is the same work, and keying by path would leave the old
 * autosave orphaned and offer it back later as if it were a separate project.
 *
 * The id is sanitised because it reaches a filename. Ids are generated here and
 * are already safe, but a project file is a JSON document a user can edit, and
 * `../../etc/passwd` as an id must become a harmless name rather than a path.
 * Windows' illegal set is the strict one, so it is the one used on both.
 */
export function autosaveName(projectId: string): string {
  const safe = projectId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    /*
     * No leading dots.
     *
     * Sanitising `../../etc/passwd` gives `.._.._etc_passwd`, which cannot
     * traverse anywhere — there are no separators left — but a name beginning
     * with a dot is HIDDEN on macOS and Linux, so the autosave would exist and
     * be invisible to anyone looking for it.
     */
    .replace(/^[._-]+/, '')
    .slice(0, 64)
  // A name that sanitised down to nothing is not a name.
  return `${/[A-Za-z0-9]/.test(safe) ? safe : 'project'}.forge.json`
}

/** How often an autosave runs while there is anything to save. */
export const AUTOSAVE_INTERVAL_MS = 60_000
