import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import type React from 'react'
import type { AssetKind, CatalogEntry, FontMeta, TitleMeta } from '@shared/assets/catalog'
import { searchEntries } from '@shared/assets/catalog'
import { useCatalog } from '../catalog'
import { useEditor } from '../store'
import { assetUrl } from '../media'
import { setDragPayload } from '../dragPayload'

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
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!catalog && !loading) void load()
  }, [catalog, loading, load])

  const counts = useMemo(() => {
    const totals: Partial<Record<AssetKind, number>> = {}
    for (const entry of catalog?.entries ?? []) {
      totals[entry.kind] = (totals[entry.kind] ?? 0) + 1
    }
    return totals
  }, [catalog])

  const matches = useMemo(
    () => searchEntries(catalog, query, kind),
    [catalog, query, kind]
  )

  useEffect(() => setLimit(PAGE), [kind, query])

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
              absolutePath={`${root}${root.endsWith('/') ? '' : '/'}${entry.file}`}
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

  const url = seen ? assetUrl(root, entry.file) : ''

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
      {entry.kind !== 'sticker' && (
        <span className="w-full truncate px-0.5 text-center text-[9px] leading-tight text-neutral-600">
          {entry.name}
        </span>
      )}
    </div>
  )
}
