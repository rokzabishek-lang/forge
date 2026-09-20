import type { ReactNode } from 'react'
import type { Clip } from '@shared/timeline'
import { carouselTurnSeconds } from '@shared/render/carousel'
import { useEditor } from '../store'
import { Slider } from './Slider'

/**
 * The controls for a card ring.
 *
 * Named after the panel in the MachiCut recording (`docs/REFERENCES.md` §2),
 * because those names came from a tool people actually use: cards, curvature,
 * visible arc, spacing, tilt and roll.
 */
export function CarouselPanel({ clip }: { clip: Clip }): ReactNode {
  const setCarousel = useEditor((s) => s.setCarousel)
  const setClipDuration = useEditor((s) => s.setClipDuration)
  const fps = useEditor((s) => s.project.settings.fps)
  const ring = clip.carousel
  if (!ring) return null

  const turn = carouselTurnSeconds(ring)

  return (
    <div className="space-y-2 border-t border-ink-850 pt-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] text-ink-400">Card ring</span>
        <span className="text-[10px] text-ink-600">
          {ring.assetIds.length} photo{ring.assetIds.length === 1 ? '' : 's'}
        </span>
      </div>

      <Slider
        label="Cards"
        value={ring.cards}
        min={1}
        max={40}
        suffix=""
        onChange={(v) => setCarousel(clip.id, { cards: Math.round(v) })}
      />
      <Slider
        label="Radius"
        value={Math.round(ring.radius * 10)}
        min={5}
        max={120}
        suffix=""
        onChange={(v) => setCarousel(clip.id, { radius: v / 10 })}
      />
      <Slider
        label="Card size"
        value={Math.round(ring.cardWidth * 100)}
        min={30}
        max={400}
        suffix="%"
        onChange={(v) => setCarousel(clip.id, { cardWidth: v / 100 })}
      />
      {/*
        The MachiCut panel's VISIBLE ARC. Below a full turn the cards spread
        over part of the circle — a shallow fan rather than a carousel.
      */}
      <Slider
        label="Visible arc"
        value={Math.round(ring.arc * 100)}
        min={5}
        max={100}
        suffix="%"
        onChange={(v) => setCarousel(clip.id, { arc: v / 100 })}
      />

      {/*
        Spin retimes the clip, so a full turn is what actually lands. Asking
        for a slow ring and getting three quarters of one reads as the spin
        being ignored rather than as the clip being too short.
      */}
      <Slider
        label="Spin"
        value={Math.round(ring.spin * 100)}
        min={-100}
        max={100}
        suffix={turn > 0 ? ` · ${turn.toFixed(1)}s a turn` : ' · still'}
        onChange={(v) => {
          const spin = v / 100
          setCarousel(clip.id, { spin })
          const seconds = carouselTurnSeconds({ ...ring, spin })
          if (seconds > 0) setClipDuration(clip.id, Math.round(seconds * fps))
        }}
      />

      <Slider
        label="Tilt"
        value={Math.round(ring.tilt * 360)}
        min={-90}
        max={90}
        suffix="°"
        onChange={(v) => setCarousel(clip.id, { tilt: v / 360 })}
      />
      <Slider
        label="Roll"
        value={Math.round(ring.roll * 360)}
        min={-180}
        max={180}
        suffix="°"
        onChange={(v) => setCarousel(clip.id, { roll: v / 360 })}
      />

      <button
        onClick={() => setCarousel(clip.id, { facingCamera: !ring.facingCamera })}
        title="Cards square to the camera instead of turned outward along the ring"
        className={`w-full rounded px-2 py-1.5 text-[10.5px] transition-colors ${
          ring.facingCamera
            ? 'bg-flame-500 text-ink-950'
            : 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
        }`}
      >
        {ring.facingCamera ? 'Facing the camera' : 'Turned along the ring'}
      </button>
    </div>
  )
}
