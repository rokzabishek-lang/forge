import { create } from 'zustand'
import type { AssetCatalog, FontMeta } from '@shared/assets/catalog'
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

  load: (force?: boolean) => Promise<void>
  ensureFont: (family: string) => Promise<boolean>
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
