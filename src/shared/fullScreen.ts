/**
 * Getting OUT of full screen.
 *
 * View → Toggle Full Screen went in and nothing came out: Escape did nothing,
 * and on Windows full screen hides the menu bar the toggle lives in, so the only
 * way back was to quit — reported from the app. Two ways out now, the ones every
 * app has: Escape, and an "Exit full screen" button across the top.
 *
 * Escape already has jobs — closing a menu or a picker, cancelling a text edit,
 * closing the shortcuts sheet — and those come first. Each of them either stops
 * the key where it is handled or marks it handled (`preventDefault`); the window
 * only leaves full screen for an Escape that arrived with nothing else wanting
 * it, and never for one typed into a field.
 */

export interface EscapeEvent {
  key: string
  defaultPrevented: boolean
  /** An element, or anything else an event can come from. */
  target: unknown
}

export function escapeLeavesFullScreen(event: EscapeEvent, fullScreen: boolean): boolean {
  if (!fullScreen || event.key !== 'Escape' || event.defaultPrevented) return false
  const target = (event.target ?? {}) as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
  if (target.isContentEditable === true) return false
  return true
}
