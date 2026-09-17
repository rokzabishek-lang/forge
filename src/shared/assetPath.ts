/**
 * Joining and comparing asset paths from the renderer, which has no `path`.
 *
 * The catalog gives the renderer a NATIVE absolute `root` from the main process
 * and entry paths that are relative and forward-slashed (`scan.ts` normalises
 * them so the same catalog reads identically on both platforms). Putting the two
 * together used to be a template literal with a literal '/' in it, in two
 * places. On macOS that is exactly what `path.join` produces. On Windows it is
 * not:
 *
 *     path.win32.join('C:\\…\\assets', 'sfx/whoosh.wav')
 *       -> 'C:\\…\\assets\\sfx\\whoosh.wav'
 *     `${root}/${entry.file}`
 *       -> 'C:\\…\\assets/sfx/whoosh.wav'
 *
 * Both open the same file — Windows accepts either separator — so nothing
 * visibly broke. What broke was every string COMPARISON between the two, and
 * the app makes one: `addAuditionToTimeline` looks for an existing asset with
 * the same path before probing, and on Windows it never found one. So the
 * dedup was a silent no-op there and nowhere else: the same sound appeared
 * twice in the media pool, was re-probed on every audition, and missed the
 * waveform cache because that is keyed on the path too.
 */

/** Join a native absolute root with a forward-slash relative path. */
export function assetPath(root: string, relative: string): string {
  if (!root) return relative
  /*
   * Decided from the SHAPE of the root, not from whether it happens to contain
   * a backslash — a POSIX filename is allowed to contain one, and guessing off
   * that would mangle it. A Windows absolute path is a drive letter or a UNC
   * share, and nothing else is.
   */
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root)
  const base = root.replace(/[\\/]+$/, '')
  return windows
    ? `${base}\\${relative.split('/').join('\\')}`
    : `${base}/${relative}`
}

/**
 * Do two paths name the same file, allowing for either separator?
 *
 * Deliberately NOT case-insensitive, even though Windows is. Folding case would
 * make `Photo.jpg` and `photo.jpg` the same asset on macOS, where they are two
 * different files — trading a silent duplicate for a silent overwrite, which is
 * the worse of the two.
 */
export function samePath(a: string, b: string): boolean {
  return a.split('\\').join('/') === b.split('\\').join('/')
}
