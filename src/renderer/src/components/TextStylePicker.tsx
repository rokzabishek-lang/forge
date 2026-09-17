import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import type { TextSpec } from '@shared/timeline'
import { TEXT_STYLES, type TextStyle } from '@shared/render/textStyle'
import { drawTextOnto } from '../textCanvas'
import { useCatalog } from '../catalog'
import { ASPECTS, useEditor } from '../store'

/**
 * The style library.
 *
 * The question this answers is "how do you show two dozen styles across fifty
 * fonts without drowning someone", and the answer is that you do not show the
 * combinations at all — you show the RECIPES, each rendered with the words and
 * the face already chosen. Every tile is the user's own text in that style,
 * drawn by the very function that draws the real thing, so these are genuine
 * previews rather than pictures of somebody else's title.
 *
 * The first version put all of them in a short scrolling box inside the
 * inspector, which already scrolls. About five were visible and nothing said
 * there were nineteen more — reported, accurately, as "why do I see very few?".
 * A nested scrollbar is close to invisible, and a library you cannot see the
 * shape of may as well not exist. So the inspector keeps a short row for
 * reaching a favourite quickly, and **Browse** opens the whole set at a size
 * where the looks can actually be judged.
 */

/** How many stay in the inspector. Enough to reach for, not enough to hunt in. */
const INLINE_COUNT = 6

export function TextStylePicker({
  spec,
  onPick
}: {
  spec: TextSpec
  onPick: (styleId: string | undefined) => void
}): ReactNode {
  const [browsing, setBrowsing] = useState(false)

  /*
   * The chosen style is always in the inline row.
   *
   * Picking "Flames" from the gallery and then finding it nowhere in the panel
   * is disorienting — the row has to be able to show what is currently on.
   */
  const inline = useMemo(() => {
    const head = TEXT_STYLES.slice(0, INLINE_COUNT)
    const current = TEXT_STYLES.find((s) => s.id === spec.styleId)
    if (!current || head.some((s) => s.id === current.id)) return head
    return [current, ...head.slice(0, INLINE_COUNT - 1)]
  }, [spec.styleId])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Style</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setBrowsing(true)}
            className="rounded px-1.5 py-0.5 text-[10px] text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          >
            Browse all {TEXT_STYLES.length}
          </button>
          {spec.styleId && (
            <button
              onClick={() => onPick(undefined)}
              className="rounded px-1.5 py-0.5 text-[10px] text-ink-600 hover:bg-ink-800 hover:text-ink-200"
            >
              None
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1">
        {inline.map((style) => (
          <Tile
            key={style.id}
            style={style}
            spec={spec}
            height={40}
            selected={spec.styleId === style.id}
            onPick={() => onPick(style.id)}
          />
        ))}
      </div>

      {browsing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-10 backdrop-blur-md"
          onClick={() => setBrowsing(false)}
        >
          <div
            className="flex h-full max-h-[680px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <Gallery
              spec={spec}
              onPick={(id) => {
                onPick(id)
                setBrowsing(false)
              }}
              onClose={() => setBrowsing(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Gallery({
  spec,
  onPick,
  onClose
}: {
  spec: TextSpec
  onPick: (styleId: string) => void
  onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  /** What the hero is showing: whatever is under the pointer, else the chosen one. */
  const [hovered, setHovered] = useState<string | null>(null)
  const showing = hovered ?? spec.styleId ?? TEXT_STYLES[0].id

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
    if (!needle) return TEXT_STYLES
    return TEXT_STYLES.filter(
      (s) => s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)
    )
  }, [query])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-ink-800 px-2 py-1.5">
        <Search size={12} className="shrink-0 text-ink-600" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${TEXT_STYLES.length} styles — glow, metal, gradient…`}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-200 outline-none placeholder:text-ink-600"
        />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-600">
          {filtered.length}
        </span>
        <button
          onClick={onClose}
          className="shrink-0 rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
        >
          <X size={12} />
        </button>
      </div>

      <Hero spec={spec} styleId={showing} />

      <div className="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto p-2">
        {filtered.map((style) => (
          <div
            key={style.id}
            className="space-y-1"
            onPointerEnter={() => setHovered(style.id)}
            onPointerLeave={() => setHovered((h) => (h === style.id ? null : h))}
          >
            <Tile
              style={style}
              spec={spec}
              height={84}
              selected={spec.styleId === style.id}
              onPick={() => onPick(style.id)}
              hideName
            />
            <div className="px-0.5">
              <div className="truncate text-[10.5px] text-ink-200">{style.name}</div>
              <div className="text-[9.5px] leading-snug text-ink-600">{style.description}</div>
            </div>
          </div>
        ))}
      </div>

      <p className="border-t border-ink-800 px-3 py-2 text-[10px] leading-snug text-ink-600">
        Every tile is your own words in your own font — change the font and they all follow. The
        style is the look; the font is the letters.
      </p>
    </div>
  )
}

/**
 * The big preview, over the real frame.
 *
 * A thumbnail answers "what is this style"; it cannot answer "does this look
 * right on MY shot", which is the only question actually being asked. So the
 * hero copies whatever the preview canvas is currently showing and draws the
 * text over it at true proportions — the same function, the same layout, the
 * same safe margin as the export.
 *
 * If the frame cannot be copied the card simply stays dark rather than
 * inventing a background: a fake backdrop would flatter some styles and
 * sabotage others, which is worse than no backdrop at all.
 */
function Hero({ spec, styleId }: { spec: TextSpec; styleId: string }): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const aspect = useEditor((s) => s.aspect)
  const loadedFonts = useCatalog((s) => s.loadedFonts)
  const target = ASPECTS[aspect]
  const style = TEXT_STYLES.find((s) => s.id === styleId)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w < 8 || h < 8) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = '#0b0b0d'
    ctx.fillRect(0, 0, w, h)

    const source = document.querySelector<HTMLCanvasElement>('canvas[data-forge-preview="1"]')
    if (source && source.width > 8) {
      try {
        // Cover: the preview pane and the project aspect rarely match, and
        // letterboxing a letterbox looks like a rendering fault.
        const scale = Math.max(w / source.width, h / source.height)
        const dw = source.width * scale
        const dh = source.height * scale
        ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh)
      } catch {
        // A tainted or empty canvas leaves the dark card, which is fine.
      }
    }

    try {
      drawTextOnto(ctx, { ...spec, styleId }, w, h)
    } catch {
      // Never let one style take the gallery down.
    }
  }, [spec, styleId, loadedFonts, target.width, target.height])

  return (
    <div className="border-b border-ink-800 px-3 pb-2.5 pt-2">
      <div
        className="mx-auto overflow-hidden rounded-md border border-ink-800 bg-ink-950"
        style={{ aspectRatio: `${target.width} / ${target.height}`, maxHeight: 230 }}
      >
        <canvas ref={ref} className="size-full" />
      </div>
      {style && (
        <div className="mt-1.5 text-center">
          <span className="text-[11px] text-ink-200">{style.name}</span>
          <span className="ml-1.5 text-[10px] text-ink-600">{style.description}</span>
        </div>
      )}
    </div>
  )
}

function Tile({
  style,
  spec,
  height,
  selected,
  onPick,
  hideName
}: {
  style: TextStyle
  spec: TextSpec
  height: number
  selected: boolean
  onPick: () => void
  hideName?: boolean
}): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const ensureFont = useCatalog((s) => s.ensureFont)
  const loadedFonts = useCatalog((s) => s.loadedFonts)

  useEffect(() => {
    void ensureFont(spec.font)
  }, [spec.font, ensureFont])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    /*
     * Sized from the element, never from a constant.
     *
     * The first version drew into a fixed 132px canvas inside a button the grid
     * had made 85px wide, so every tile showed the left two-thirds of a word.
     * The element knows how wide it actually is; nothing else does.
     */
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w < 8 || h < 8) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    /*
     * Drawn by the real function, at tile size.
     *
     * `layoutText` works in fractions of the canvas, so a small canvas gives a
     * faithful miniature rather than an approximation — the same reason the
     * preview and the export cannot disagree. A tile that merely resembled the
     * style would be worse than none: a promise the export does not keep.
     */
    const preview: TextSpec = {
      ...spec,
      styleId: style.id,
      content: previewWords(spec.content, style),
      // A ceiling, not a guess: the wrap-and-fit inside drawTextOnto brings down
      // anything that will not sit inside the safe margin.
      size: style.accent ? 0.3 : 0.42,
      align: 'center',
      position: 'center',
      offsetX: 0,
      offsetY: 0
    }
    try {
      drawTextOnto(ctx, preview, w, h)
    } catch {
      // A style that cannot draw must not take the whole panel down with it.
    }
  }, [style, spec, loadedFonts, height])

  return (
    <button
      onClick={onPick}
      title={`${style.name} — ${style.description}`}
      // shrink-0: in a scrolling flex column a fixed height is only a hint, and
      // the tiles were squashed to a few pixels tall.
      className={`relative w-full shrink-0 overflow-hidden rounded-md border transition-colors ${
        selected
          ? 'border-flame-500 bg-ink-850'
          : 'border-ink-850 bg-ink-900 hover:border-ink-700 hover:bg-ink-850'
      }`}
      style={{ height }}
    >
      <canvas ref={ref} className="pointer-events-none absolute inset-0 size-full" />
      {!hideName && (
        <span className="pointer-events-none absolute bottom-0 left-0 right-0 truncate bg-gradient-to-t from-ink-950/85 to-transparent px-1 pb-0.5 pt-2 text-left text-[9px] text-ink-400">
          {style.name}
        </span>
      )}
    </button>
  )
}

/**
 * What to show in a tile.
 *
 * The user's real text — but a two-line style has to be shown as two lines or
 * the accent, which is the entire point of it, is invisible. When their text is
 * a single line the style's own name stands in for the second, so the pairing
 * can still be seen.
 */
function previewWords(content: string, style: TextStyle): string {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const first = (lines[0] ?? 'Your text').slice(0, 18)
  if (!style.accent) return first
  return `${first}\n${(lines[1] ?? style.name).slice(0, 18)}`
}
