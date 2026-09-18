import { create } from 'zustand'
import type { PackListing, PackProgress } from '@shared/assets/pack'
import { orderPacks } from '@shared/assets/pack'
import { useCatalog } from './catalog'

/**
 * The downloadable asset packs, as the Library panel sees them.
 *
 * Deliberately separate from `useCatalog`: what is INSTALLABLE and what is
 * INSTALLED are different questions with different failure modes, and the panel
 * has to be able to answer the first while the second is broken — somebody
 * whose library will not scan is exactly the person who wants this list.
 *
 * Nothing here is allowed to block the Library from opening. A failed fetch
 * lands in `error` beside a list that is still the built-in one.
 */
interface PacksState {
  packs: PackListing[]
  loaded: boolean
  loading: boolean
  /** Why the LIST could not be fetched. Per-pack failures live in `failed`. */
  error: string | null
  /** id → where its download has got to. Present only while one is running. */
  inFlight: Map<string, PackProgress>
  /** id → why its last install failed, in the words main used. */
  failed: Map<string, string>

  load: (refresh?: boolean) => Promise<void>
  install: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Subscribe to progress from main. Returns the unsubscribe. */
  watch: () => () => void
}

/**
 * Ids the user cancelled, so the rejection that follows is not shown as a
 * failure.
 *
 * The alternative was matching on the error message, which would have made
 * "Cancelled" a load-bearing string across the IPC boundary. The renderer
 * already knows perfectly well that it pressed cancel.
 */
const cancelled = new Set<string>()

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** After a pack lands or leaves, the library on screen is a different library. */
async function rescanCatalog(): Promise<void> {
  const catalog = useCatalog.getState()
  // Unforced: main has already rescanned and cached, so this reads that result
  // rather than paying for a second walk of ~1,800 files.
  await catalog.load()
  await catalog.loadTransitions()
}

export const usePacks = create<PacksState>((set, get) => ({
  packs: [],
  loaded: false,
  loading: false,
  error: null,
  inFlight: new Map(),
  failed: new Map(),

  load: async (refresh = false) => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const packs = await window.forge.assetPacks(refresh)
      set({ packs: orderPacks(packs), loaded: true, loading: false })
    } catch (err) {
      set({ loading: false, loaded: true, error: message(err) })
    }
  },

  install: async (id: string) => {
    if (get().inFlight.has(id)) return
    cancelled.delete(id)
    set((s) => {
      const failed = new Map(s.failed)
      failed.delete(id)
      return {
        failed,
        inFlight: new Map(s.inFlight).set(id, { progress: 0, message: 'starting' })
      }
    })

    try {
      const listing = await window.forge.installAssetPack(id)
      set((s) => ({ packs: s.packs.map((p) => (p.id === id ? listing : p)) }))
      await rescanCatalog()
    } catch (err) {
      /*
       * A cancel is not a failure, but the LIST still has to be re-read.
       *
       * Installing writes into a staging directory and swaps it in at the end,
       * so a cancelled install leaves what was there before — which may be an
       * older version, or nothing. Guessing either would put the wrong button
       * on screen, so it asks.
       */
      if (cancelled.has(id)) {
        cancelled.delete(id)
        void get().load()
      } else {
        set((s) => ({ failed: new Map(s.failed).set(id, message(err)) }))
      }
    } finally {
      set((s) => {
        const inFlight = new Map(s.inFlight)
        inFlight.delete(id)
        return { inFlight }
      })
    }
  },

  cancel: async (id: string) => {
    cancelled.add(id)
    await window.forge.cancelAssetPack(id)
  },

  remove: async (id: string) => {
    try {
      const packs = await window.forge.removeAssetPack(id)
      set((s) => {
        const failed = new Map(s.failed)
        failed.delete(id)
        return { packs: orderPacks(packs), failed }
      })
      await rescanCatalog()
    } catch (err) {
      set((s) => ({ failed: new Map(s.failed).set(id, message(err)) }))
    }
  },

  watch: () =>
    window.forge.onPackProgress(({ id, progress, message: text }) => {
      set((s) => {
        // Only while we believe it is running: a late event after a cancel must
        // not resurrect a bar the user has already dismissed.
        if (!s.inFlight.has(id)) return s
        return { inFlight: new Map(s.inFlight).set(id, { progress, message: text }) }
      })
    })
}))
