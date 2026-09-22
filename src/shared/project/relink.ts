/**
 * Projects that survive being moved.
 *
 * Every asset was stored as one absolute path and nothing else, so a project
 * opened on another machine — or after the footage folder was renamed, or from
 * an external drive that mounted somewhere else — came back pointing at files
 * that are not there. And nothing said so: `project:open` checked only the
 * parallax bakes, the preview skipped a layer that would not load, and the
 * result was a timeline of black clips with no explanation and no way back.
 *
 * Three things fix that, and all three are decisions rather than I/O, so they
 * live here and the filesystem work stays in the main process:
 *
 * 1. **Where to look** — absolute, then relative to the project file, then the
 *    folders this project has found media in before.
 * 2. **What to say** when it is still not there: the asset is marked offline,
 *    which every surface can then show.
 * 3. **How to relink** — match by basename, then by basename and size, which
 *    is what makes "point me at the folder" work for a hundred files at once.
 */

import type { MediaAsset, Project } from '../timeline'

/** Split a path on either separator, so one function reads both platforms. */
export function baseNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? path : path.slice(at + 1)
}

export function dirNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? '' : path.slice(0, at)
}

/**
 * Join the way the platform the ROOT came from would.
 *
 * Decided from the shape of the root, not from the current platform: a project
 * written on Windows and opened on a Mac carries Windows roots, and a POSIX
 * filename is allowed to contain a backslash. The same rule `assetPath` uses.
 */
export function joinPath(root: string, relative: string): string {
  if (!root) return relative
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root)
  const base = root.replace(/[\\/]+$/, '')
  return windows
    ? `${base}\\${relative.split('/').join('\\')}`
    : `${base}/${relative.split('\\').join('/')}`
}

/**
 * A path relative to the project file's folder, when one can be expressed.
 *
 * Only when the asset sits under the project's own folder — the common and
 * useful case, where footage travels with the project. Anything outside it
 * would need `../..` segments that stop meaning anything the moment either end
 * moves, so those keep their absolute path alone and rely on relinking.
 */
export function relativeToProject(assetPath: string, projectDir: string): string | null {
  if (!projectDir) return null
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const dir = norm(projectDir)
  const file = norm(assetPath)
  // Case-sensitive: macOS and Linux are, and a case-insensitive match here
  // would produce a relative path that resolves on one platform and not the
  // other — which is the exact failure this whole module exists to prevent.
  if (!file.startsWith(`${dir}/`)) return null
  const rest = file.slice(dir.length + 1)
  return rest.length > 0 ? rest : null
}

/**
 * Every place an asset might be, in the order to try them.
 *
 * Absolute first: on the machine that made the project it is simply right, and
 * trying anything else first would find a same-named file in the wrong folder.
 */
export function candidatePaths(
  asset: Pick<MediaAsset, 'path' | 'relativeTo'>,
  projectDir: string | null,
  searchFolders: string[] = []
): string[] {
  const out = [asset.path]
  if (asset.relativeTo && projectDir) out.push(joinPath(projectDir, asset.relativeTo))
  const name = baseNameOf(asset.path)
  for (const folder of searchFolders) out.push(joinPath(folder, name))
  // Deduplicated, because a stat per candidate is the expensive part and the
  // same path arrives twice whenever a project sits beside its footage.
  return [...new Set(out)]
}

/**
 * Match assets to files by name, then by name and size.
 *
 * Name alone is what makes "point me at the folder" work at all: a hundred
 * clips relink in one gesture. Size is the tie-breaker, and it matters more
 * than it sounds — `IMG_0001.MOV` is the most common filename in the world,
 * and a folder of footage from two cameras has several.
 *
 * An asset whose name matches more than one candidate and whose size matches
 * none of them is left ALONE rather than pointed at a guess. A wrongly relinked
 * clip is worse than an offline one: it renders, it looks plausible, and
 * nothing says it is the wrong take.
 */
export function matchByName(
  assets: Pick<MediaAsset, 'id' | 'path' | 'size'>[],
  files: { path: string; size: number }[]
): Record<string, string> {
  const byName = new Map<string, { path: string; size: number }[]>()
  for (const file of files) {
    const key = baseNameOf(file.path).toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), file])
  }

  const found: Record<string, string> = {}
  for (const asset of assets) {
    const candidates = byName.get(baseNameOf(asset.path).toLowerCase())
    if (!candidates || candidates.length === 0) continue
    if (candidates.length === 1) {
      found[asset.id] = candidates[0].path
      continue
    }
    /*
     * Several of the same name. Size decides, and only an exact match counts —
     * `size` is 0 for assets this app drew itself, so a zero-size asset must
     * not match the first zero-size file it meets.
     */
    const exact = asset.size > 0 ? candidates.filter((c) => c.size === asset.size) : []
    if (exact.length === 1) found[asset.id] = exact[0].path
  }
  return found
}

/** Repoint assets at the files found for them. Ids not present are untouched. */
export function applyRelink(project: Project, found: Record<string, string>): Project {
  if (Object.keys(found).length === 0) return project
  return {
    ...project,
    assets: project.assets.map((asset) => {
      const path = found[asset.id]
      if (!path) return asset
      // `offline` is runtime-only, so it is cleared rather than set false —
      // a false that reached the project file would be serialised noise.
      const { offline: _gone, ...rest } = asset
      return { ...rest, path }
    })
  }
}

/** The assets an export would be missing, by name, for a refusal that helps. */
export function offlineAssets(project: Project): MediaAsset[] {
  /*
   * Assets nothing uses are not a reason to refuse an export.
   *
   * A pool with an offline file in it that no clip references does not affect
   * the render at all, and refusing over it would be an export blocked by
   * something invisible in the output.
   */
  const used = new Set(project.clips.map((c) => c.assetId))
  return project.assets.filter((a) => a.offline && used.has(a.id))
}
