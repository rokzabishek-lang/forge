import { create } from 'zustand'
import type { AssetCatalog, FontMeta } from '@shared/assets/catalog'
import type { TransitionDef, TransitionFamily } from '@shared/transitions/registry'
import { TRANSITIONS } from '@shared/transitions/registry'
import { fontFamilies, SYSTEM_FONT_FAMILIES } from '@shared/assets/catalog'

// Re-exported so components have one import for catalog access.
export { fontFamilies, searchEntries } from '@shared/assets/catalog'

interface CatalogState {
  catalog: AssetCatalog | null
  root: string
  exists: boolean
  loading: boolean
  error: string | null
  /** Families whose @font-face has been registered with the document. */
  loadedFonts: Set<string>
  /** Families that failed, with the reason — shown on the card, not swallowed. */
  failedFonts: Map<string, string>

  /** Built-ins plus every mask wipe found in the asset library. */
  transitions: TransitionDef[]
  /** Why the mask library is missing, when it is. Null while all is well. */
  transitionsError: string | null

  load: (force?: boolean) => Promise<void>
  ensureFont: (family: string) => Promise<boolean>
  loadTransitions: () => Promise<void>
}

/** Members of a family, so the picker can offer a handful rather than 400. */
export function transitionsByFamily(
  all: TransitionDef[]
): { family: TransitionFamily; members: TransitionDef[] }[] {
  const grouped = new Map<TransitionFamily, TransitionDef[]>()
  for (const transition of all) {
    const existing = grouped.get(transition.family)
    if (existing) existing.push(transition)
    else grouped.set(transition.family, [transition])
  }
  return [...grouped.entries()].map(([family, members]) => ({ family, members }))
}


/** Registrations in flight, so a family is never fetched twice. */
const pending = new Map<string, Promise<boolean>>()

export const useCatalog = create<CatalogState>((set, get) => ({
  catalog: null,
  root: '',
  exists: false,
  loading: false,
  error: null,
  loadedFonts: new Set(),
  failedFonts: new Map(),
  transitions: TRANSITIONS,
  transitionsError: null,

  load: async (force = false) => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const { catalog, root, exists } = await window.forge.assetCatalog(force)
      set({ catalog, root, exists, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  /**
   * Register a font with the document so it can be previewed and rendered.
   *
   * System families are already installed, so registering them would download
   * nothing and could shadow the real face — they resolve by name instead.
   */
  loadTransitions: async () => {
    try {
      const masks = await window.forge.transitionLibrary()
      // Built-ins first: they are the ones that work with no asset library.
      set({ transitions: [...TRANSITIONS, ...masks], transitionsError: null })
    } catch (err) {
      /*
       * Say so, rather than quietly showing eight.
       *
       * This used to swallow the error entirely, on the reasoning that the
       * built-ins are still a usable set. They are — but the difference between
       * 412 transitions and 8 is the difference between the feature working and
       * the feature being gone, and nothing on screen distinguished "you have no
       * asset library" from "the library failed to load". Reported as the
       * transitions having disappeared, which is exactly what it looks like.
       */
      const reason = err instanceof Error ? err.message : String(err)
      set({ transitionsError: reason })
      console.warn('Transition library failed to load', err)
    }
  },

  ensureFont: async (family: string) => {
    if (SYSTEM_FONT_FAMILIES.has(family)) return true
    if (get().loadedFonts.has(family)) return true
    if (get().failedFonts.has(family)) return false

    const existing = pending.get(family)
    if (existing) return existing

    const promise = (async () => {
      const entry = fontFamilies(get().catalog).find(
        (f) => (f.meta as FontMeta).family === family
      )
      if (!entry) {
        set((s) => ({ failedFonts: new Map(s.failedFonts).set(family, 'not in the catalog') }))
        return false
      }

      try {
        // Bytes, not a URL: a URL source goes through a CORS fetch that the
        // custom protocol cannot satisfy cleanly. An ArrayBuffer source has no
        // network step at all.
        const data = await window.forge.assetFontData(entry.file)
        const face = new FontFace(family, data)
        await face.load()
        document.fonts.add(face)
        set((s) => ({ loadedFonts: new Set(s.loadedFonts).add(family) }))
        return true
      } catch (err) {
        // A font that will not load must not break the picker — but it must not
        // be invisible either. A silent failure here looks exactly like "the
        // preview feature was never built", which cost us two rounds.
        const reason = err instanceof Error ? err.message : String(err)
        set((s) => ({ failedFonts: new Map(s.failedFonts).set(family, reason) }))
        console.warn('Font failed to load', family, entry.file, reason)
        return false
      } finally {
        pending.delete(family)
      }
    })()

    pending.set(family, promise)
    return promise
  },

}))
