/**
 * Local files reach the renderer through the privileged forge-media scheme.
 *
 * `version` exists for generated artwork — text, colour cards, titles — which is
 * rewritten in place at the same path on every edit. Chromium caches by URL, so
 * without a changing parameter it keeps serving the bytes from the first fetch:
 * the file on disk says what you typed and the picture on screen still says YOUR
 * TEXT. Real media leaves it off and stays cached, which is what we want.
 */
export function mediaUrl(path: string, version?: number): string {
  // Already a URL — a blob: or data: source made in the renderer itself. It has
  // no file behind it for the protocol to serve, and wrapping it would only
  // hide that.
  if (/^(blob:|data:|https?:)/.test(path)) return path
  const base = `forge-media://local/?p=${encodeURIComponent(path)}`
  return version === undefined ? base : `${base}&v=${version}`
}
