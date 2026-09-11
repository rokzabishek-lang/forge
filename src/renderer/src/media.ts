/** Local files reach the renderer through the privileged forge-media scheme. */
export function mediaUrl(path: string): string {
  return `forge-media://local/?p=${encodeURIComponent(path)}`
}

/**
 * URL for a catalog entry, built client-side.
 *
 * The catalog stores paths relative to a root the renderer already knows, so a
 * per-file IPC round-trip is unnecessary — and with 1,239 stickers it would be
 * 1,239 round-trips to paint one grid.
 */
export function assetUrl(root: string, relativePath: string): string {
  if (!root) return ''
  const separator = root.endsWith('/') ? '' : '/'
  return mediaUrl(`${root}${separator}${relativePath}`)
}
