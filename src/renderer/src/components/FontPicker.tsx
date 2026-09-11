import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Search, X } from 'lucide-react'
import type { FontMeta } from '@shared/assets/catalog'
import { fontFamilies, useCatalog } from '../catalog'

/**
 * Font picker over the whole library.
 *
 * Each row previews in its own face, which means loading a font file per visible
 * row — so only the rows actually on screen are registered, via an
 * IntersectionObserver. Registering all 88 up front stalls the UI for seconds.
 */
export function FontPicker({
  value,
  onChange,
  onClose
}: {
  value: string
  onChange: (family: string) => void
  onClose: () => void
}): ReactNode {
  // Select the raw catalog and derive here: a selector returning a fresh array
  // every render loops forever.
  const catalog = useCatalog((s) => s.catalog)
  const ensureFont = useCatalog((s) => s.ensureFont)
  const loadedFonts = useCatalog((s) => s.loadedFonts)
  const fonts = useMemo(() => fontFamilies(catalog), [catalog])
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = fonts.map((f) => f.meta as FontMeta)
    if (!needle) return rows
    return rows.filter((f) => f.family.toLowerCase().includes(needle))
  }, [fonts, query])

  // Load only what is visible.
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue
          const family = (record.target as HTMLElement).dataset.family
          if (family) void ensureFont(family)
        }
      },
      { root: container, rootMargin: '120px' }
    )
    for (const row of container.querySelectorAll('[data-family]')) observer.observe(row)
    return () => observer.disconnect()
  }, [filtered, ensureFont])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-ink-800 px-2 py-1.5">
        <Search size={12} className="shrink-0 text-ink-600" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${fonts.length} fonts`}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-200 outline-none placeholder:text-ink-600"
        />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-600">
          {filtered.length}
        </span>
        <button onClick={onClose} className="shrink-0 rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200">
          <X size={12} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-ink-600">
            {fonts.length === 0 ? (
              <>
                No font library found.
                <br />
                <span className="text-ink-700">
                  Expected a fonts folder under the assets directory.
                </span>
              </>
            ) : (
              'No match'
            )}
          </div>
        )}
        {filtered.map((font) => {
          const selected = font.family === value
          const ready = loadedFonts.has(font.family) || font.source === 'system'
          return (
            <button
              key={font.family}
              data-family={font.family}
              onClick={() => onChange(font.family)}
              className={`flex w-full items-center gap-3 border-b border-ink-850 px-3 py-2.5 text-left transition-colors ${
                selected ? 'bg-flame-500/15' : 'hover:bg-ink-850'
              }`}
            >
              {/* Specimen on white: a typeface is judged by its shapes, and dark
                  backgrounds flatten fine weights. */}
              <span className="flex h-10 w-14 shrink-0 items-center justify-center rounded border border-ink-700 bg-white">
                {ready ? (
                  <span
                    className="text-[22px] leading-none text-neutral-900"
                    style={{ fontFamily: `"${font.family}", sans-serif` }}
                  >
                    Ag
                  </span>
                ) : (
                  <span className="h-5 w-8 animate-pulse rounded bg-neutral-200" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-ink-200">
                {font.family}
              </span>
              {font.restricted && (
                <span title="This font's filename declares a usage restriction" className="shrink-0 text-[9px] text-amber-500">
                  restricted
                </span>
              )}
              {font.source === 'system' && (
                <span title="Installed on this machine; not bundled" className="shrink-0 text-[9px] text-ink-600">
                  system
                </span>
              )}
              {selected && <Check size={12} className="shrink-0 text-flame-500" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
