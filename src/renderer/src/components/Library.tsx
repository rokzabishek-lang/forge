import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Package, RefreshCw, Search } from 'lucide-react'
import type React from 'react'
import type { AssetKind, CatalogEntry, FontMeta, TitleMeta } from '@shared/assets/catalog'
import { isClipSticker, searchEntries, stickerCategoryLabel } from '@shared/assets/catalog'
import { assetPath } from '@shared/assetPath'
import { useCatalog } from '../catalog'
import { useEditor } from '../store'
import { assetUrl } from '../media'
import { setDragPayload } from '../dragPayload'
import { PackList } from './PackList'

const KINDS: { id: AssetKind; label: string }[] = [
  { id: 'font', label: 'Fonts' },
  { id: 'prop', label: 'Props' },
  { id: 'sticker', label: 'Stickers' },
  { id: 'transition', label: 'Transitions' },
  { id: 'title', label: 'Titles' },
  { id: 'sfx', label: 'SFX' }
]

/** Rendered at once; more load as the grid is scrolled. */
const PAGE = 120

export function Library(): ReactNode {
  const catalog = useCatalog((s) => s.catalog)
  const root = useCatalog((s) => s.root)
  const loading = useCatalog((s) => s.loading)
  const error = useCatalog((s) => s.error)
  const load = useCatalog((s) => s.load)
  const ensureFont = useCatalog((s) => s.ensureFont)
  const loadedFonts = useCatalog((s) => s.loadedFonts)
  const failedFonts = useCatalog((s) => s.failedFonts)

  const audition = useEditor((s) => s.audition)
  const setAudition = useEditor((s) => s.setAudition)
  const [kind, setKind] = useState<AssetKind>('font')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [category, setCategory] = useState<string | null>(null)
  const [showPacks, setShowPacks] = useState(false)
  const autoOpenedPacks = useRef(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!catalog && !loading) void load()
  }, [catalog, loading, load])

  const empty = (catalog?.entries.length ?? 0) === 0

  /*
   * An empty library IS the offer.
   *
   * A packaged build ships with no assets at all (docs/PACKAGING.md), so the
   * first thing most people will ever see here is "Nothing here." Putting the
   * packs behind a button they would have to find first makes that dead end
   * look like the product.
   *
   * Opened once, then left alone — deriving it from `empty` instead meant the
   * list vanished the instant an install finished, taking the Remove button and
   * every other pack with it. The panel that just did something is not the
   * panel to make disappear; after this the toggle owns it.
   */
  useEffect(() => {
    if (catalog && empty && !autoOpenedPacks.current) {
      autoOpenedPacks.current = true
      setShowPacks(true)
    }
  }, [catalog, empty])

  const counts = useMemo(() => {
    const totals: Partial<Record<AssetKind, number>> = {}
    for (const entry of catalog?.entries ?? []) {
      totals[entry.kind] = (totals[entry.kind] ?? 0) + 1
    }
    return totals
  }, [catalog])

  const kindMatches = useMemo(
    () => searchEntries(catalog, query, kind),
    [catalog, query, kind]
  )

  /*
   * Sheet ⑨'s "Categories: Telugu, Hindi, trending …etc".
   *
   * Only for stickers, and only once there is more than one — a row that always
   * reads "All · Telugu" is a control that has never had a decision to make.
   * Derived from what is INSTALLED rather than from the manifest, so it lists
   * what this person actually has rather than what they could have.
   */
  const categories = useMemo(() => {
    if (kind !== 'sticker') return []
    const seen = new Map<string, string>()
    for (const entry of catalog?.entries ?? []) {
      if (entry.kind !== 'sticker' || !isClipSticker(entry.meta)) continue
      const raw = entry.meta.category
      if (raw && !seen.has(raw)) seen.set(raw, stickerCategoryLabel(raw))
    }
    return [...seen].map(([raw, label]) => ({ raw, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [catalog, kind])

  const matches = useMemo(() => {
    if (!category) return kindMatches
    return kindMatches.filter(
      (entry) => isClipSticker(entry.meta) && entry.meta.category === category
    )
  }, [kindMatches, category])

  // A category chosen under Stickers means nothing under Fonts, and a filter
  // nobody can see is a panel that looks empty for no reason.
  useEffect(() => setCategory(null), [kind])

  useEffect(() => setLimit(PAGE), [kind, query, category])

  // Grow the page as the sentinel comes into view, rather than rendering 1,239
  // nodes up front.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scroller = scrollerRef.current
    if (!sentinel || !scroller) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setLimit((current) => Math.min(current + PAGE, matches.length))
        }
      },
      { root: scroller, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [matches.length, kind, query])

  const visible = matches.slice(0, limit)

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="flex items-center gap-1.5 border-b border-ink-800 px-2 py-1.5">
        <Search size={12} className="shrink-0 text-ink-600" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the library"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-200 outline-none placeholder:text-ink-600"
        />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-600">
          {matches.length}
        </span>
        <button
          onClick={() => setShowPacks((open) => !open)}
          title="Asset packs — download more fonts, transitions and stickers"
          className={`shrink-0 rounded p-0.5 hover:bg-ink-800 hover:text-ink-200 ${
            showPacks ? 'text-flame-400' : 'text-ink-600'
          }`}
        >
          <Package size={11} />
        </button>
        <button
          onClick={() => void load(true)}
          title="Rescan the asset library"
          className="shrink-0 rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-ink-800 px-2 py-1.5">
        {KINDS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setKind(entry.id)}
            className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
              kind === entry.id
                ? 'bg-ink-700 text-ink-200'
                : 'bg-ink-850 text-ink-400 hover:bg-ink-800'
            }`}
          >
            {entry.label}
            <span className="ml-1 text-ink-600">{counts[entry.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-ink-800 px-2 py-1.5">
          <button
            onClick={() => setCategory(null)}
            className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
              category === null
                ? 'bg-flame-500 font-medium text-ink-950'
                : 'bg-ink-850 text-ink-400 hover:bg-ink-800'
            }`}
          >
            All
          </button>
          {categories.map((entry) => (
            <button
              key={entry.raw}
              onClick={() => setCategory(entry.raw === category ? null : entry.raw)}
              title={entry.raw.replace(/^\d+[_-]/, '').replace(/[_-]+/g, ' ')}
              className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
                category === entry.raw
                  ? 'bg-flame-500 font-medium text-ink-950'
                  : 'bg-ink-850 text-ink-400 hover:bg-ink-800'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollerRef} className="flex-1 overflow-y-auto p-2">
        {error && (
          <div className="px-2 py-4 text-center text-[11px] text-red-400">{error}</div>
        )}
        {!error && !catalog && (
          <div className="px-2 py-6 text-center text-[11px] text-ink-600">
            {loading ? 'Scanning the asset library…' : 'No library loaded'}
          </div>
        )}
        {catalog && matches.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-600">
            Nothing here.
            <br />
            <span className="text-ink-700">Looked in {root || 'the assets folder'}</span>
          </div>
        )}

        {showPacks && (
          <div className={`-mx-2 ${empty ? '' : 'mb-2 border-b border-ink-800 pb-1'}`}>
            <PackList />
          </div>
        )}

        <div
          className={
            kind === 'font'
              ? 'grid grid-cols-2 gap-2'
              : kind === 'sfx'
                ? 'flex flex-col gap-1'
                : 'grid grid-cols-4 gap-1.5'
          }
        >
          {visible.map((entry) => (
            <Tile
              key={entry.id}
              entry={entry}
              root={root}
              absolutePath={assetPath(root, entry.file)}
              auditioning={audition?.name === entry.name}
              onAudition={setAudition}
              fontReady={loadedFonts.has((entry.meta as FontMeta).family)}
              fontError={failedFonts.get((entry.meta as FontMeta).family) ?? null}
              onNeedFont={ensureFont}
            />
          ))}
        </div>

        {limit < matches.length && (
          <div ref={sentinelRef} className="py-4 text-center text-[10px] text-ink-600">
            Loading more…
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({
  entry,
  root,
  fontReady,
  fontError,
  onNeedFont,
  onAudition,
  auditioning,
  absolutePath
}: {
  entry: CatalogEntry
  root: string
  fontReady: boolean
  fontError: string | null
  onNeedFont: (family: string) => Promise<boolean>
  onAudition: (audition: { path: string; name: string }) => void
  auditioning: boolean
  absolutePath: string
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const [seen, setSeen] = useState(false)

  // Only fetch a preview once the tile is actually on screen.
  useEffect(() => {
    const element = ref.current
    if (!element || seen) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setSeen(true)
          if (entry.kind === 'font') void onNeedFont((entry.meta as FontMeta).family)
        }
      },
      { rootMargin: '150px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [entry, onNeedFont, seen])

  /*
   * A clip sticker is an mp4, and the grid draws with an `<img>`.
   *
   * So it shows the cut-out still the pack ships instead. Without it every
   * sticker tile is blank — the pack installs, the catalog is right, and the
   * drawer looks empty, which is this project's favourite kind of bug.
   */
  const clip = entry.kind === 'sticker' && isClipSticker(entry.meta) ? entry.meta : null
  const preview = clip?.thumb ?? entry.file
  const url = seen ? assetUrl(root, preview) : ''

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragPayload(e, {
        kind: entry.kind,
        file: entry.file,
        name: entry.name,
        ...(entry.kind === 'transition' ? { transitionId: entry.id } : {})
      })
    }
  }

  if (entry.kind === 'font') {
    const meta = entry.meta as FontMeta
    return (
      <div
        ref={ref}
        title={meta.family}
        className="flex h-28 flex-col overflow-hidden rounded-lg border border-ink-700 bg-white shadow-sm transition-colors hover:border-flame-500"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2">
          {fontReady ? (
            <span
              className="truncate text-[30px] leading-none text-neutral-900"
              style={{ fontFamily: `"${meta.family}", sans-serif` }}
            >
              Ag
            </span>
          ) : fontError ? (
            <span
              title={fontError}
              className="px-1 text-center text-[9px] leading-tight text-red-500"
            >
              cannot load
            </span>
          ) : (
            <span className="h-7 w-20 animate-pulse rounded bg-neutral-200" />
          )}
        </div>

        {/* The specimen shows the shapes; this line says which font they are. */}
        <div className="flex shrink-0 items-center gap-1 border-t border-neutral-200 px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-700">
            {meta.family}
          </span>
          {meta.restricted && <span className="shrink-0 text-[8.5px] text-amber-600">restricted</span>}
          {meta.source === 'system' && (
            <span className="shrink-0 text-[8.5px] text-neutral-400">system</span>
          )}
        </div>
      </div>
    )
  }

  if (entry.kind === 'sfx') {
    const url = assetUrl(root, entry.file)
    return (
      <button
        ref={ref as unknown as React.RefObject<HTMLButtonElement>}
        {...dragProps}
        onClick={() => {
          // Auditioning loads it into the waveform below, where it can be heard
          // and trimmed before it is placed.
          onAudition({ path: absolutePath, name: entry.name })
          const audio = new Audio(url)
          void audio.play().catch(() => undefined)
        }}
        title="Play and show in the trimmer"
        className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
          auditioning
            ? 'border-flame-500 bg-flame-500/15'
            : 'border-ink-700 bg-ink-850 hover:border-ink-600 hover:bg-ink-800'
        }`}
      >
        <span className="shrink-0 text-[10px] text-flame-400">▶</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-200">{entry.name}</span>
      </button>
    )
  }

  const title = entry.kind === 'title' ? (entry.meta as TitleMeta) : null

  return (
    <div
      ref={ref}
      {...dragProps}
      title={
        entry.kind === 'transition'
          ? `${entry.name} — drag onto a clip to apply it`
          : `${entry.name} — drag onto the timeline${title ? ` · ${title.textSlots} text slot${title.textSlots === 1 ? '' : 's'}` : ''}`
      }
      className="group flex cursor-grab flex-col gap-1 overflow-hidden rounded-md border border-ink-700 bg-white p-1 shadow-sm transition-colors hover:border-flame-500 active:cursor-grabbing"
    >
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-sm bg-white">
        {url ? (
          <img
            src={url}
            alt={entry.name}
            loading="lazy"
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="size-full animate-pulse rounded-sm bg-neutral-200" />
        )}
      </div>
      {/*
        An emoji tile IS its name — the character fills it, and a caption under
        it would just repeat the picture. A meme sticker's title is the only way
        to tell two reaction faces apart.
      */}
      {(entry.kind !== 'sticker' || clip) && (
        <span className="w-full truncate px-0.5 text-center text-[9px] leading-tight text-neutral-600">
          {entry.name}
        </span>
      )}
    </div>
  )
}
