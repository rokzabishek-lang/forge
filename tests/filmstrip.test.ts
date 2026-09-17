import { describe, it, expect } from 'vitest'
import { planFilmstrip, filmstripClips, FILMSTRIP_RULE } from '@shared/automation/filmstrip'
import { pathAt } from '@shared/render/path'
import type { MediaAsset } from '@shared/timeline'

function images(n: number): MediaAsset[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `img${i}`, path: `/p${i}.jpg`, name: `${i}.jpg`, kind: 'image' as const,
    durationFrames: 90, width: 4000, height: 3000, fps: null,
    hasVideo: true, hasAudio: false, size: 0
  }))
}

describe('planFilmstrip', () => {
  it('makes one panel per image', () => {
    expect(planFilmstrip(images(6), 90).length).toBe(6)
  })

  it('sizes panels so the requested number fit across', () => {
    expect(planFilmstrip(images(6), 90, { visible: 4 })[0].width).toBeCloseTo(0.25, 6)
    expect(planFilmstrip(images(6), 90, { visible: 3 })[0].width).toBeCloseTo(1 / 3, 6)
  })

  it('spaces panels edge to edge, with no gap and no overlap', () => {
    const panels = planFilmstrip(images(5), 90, { visible: 4 })
    // In half-canvas units a quarter-width panel is 0.5 wide.
    for (let i = 1; i < panels.length; i++) {
      const gap = panels[i].path[0].x - panels[i - 1].path[0].x
      expect(gap).toBeCloseTo(panels[i].width * 2, 6)
    }
  })

  it('moves every panel by the same amount', () => {
    // The row has to read as one object, not several sliding clips.
    const panels = planFilmstrip(images(5), 90)
    const travels = panels.map((p) => p.path[1].x - p.path[0].x)
    for (const t of travels) expect(t).toBeCloseTo(travels[0], 6)
  })

  it('travels left by default and right when asked', () => {
    expect(planFilmstrip(images(4), 90)[0].path[1].x).toBeLessThan(
      planFilmstrip(images(4), 90)[0].path[0].x
    )
    const right = planFilmstrip(images(4), 90, { direction: 'right' })[0]
    expect(right.path[1].x).toBeGreaterThan(right.path[0].x)
  })

  it('carries the whole row past the frame', () => {
    // Every panel must leave, or the strip stops with one stuck on screen.
    const panels = planFilmstrip(images(5), 90, { visible: 4 })
    for (const panel of panels) {
      const end = pathAt(panel.path, 89, 90)!.x
      expect(Math.abs(end)).toBeGreaterThan(1)
    }
  })

  it('returns nothing for no images or a clip too short to move', () => {
    expect(planFilmstrip([], 90)).toEqual([])
    expect(planFilmstrip(images(3), 1)).toEqual([])
  })
})

describe('filmstripClips', () => {
  it('builds narrow full-height panels that fill rather than letterbox', () => {
    const clips = filmstripClips(planFilmstrip(images(5), 90, { visible: 4 }), 'v1', 0, 90)
    for (const clip of clips) {
      expect(clip.transform.scale).toBeCloseTo(0.25, 6)
      expect(clip.transform.scaleY).toBe(1)
      // A landscape photo letterboxed into a tall strip is a floating band.
      expect(clip.transform.fit).toBe('cover')
    }
  })

  it('gives every panel a path and a reason', () => {
    const clips = filmstripClips(planFilmstrip(images(4), 90), 'v1', 30, 90)
    for (const clip of clips) {
      expect(clip.path?.length).toBe(2)
      expect(clip.generatedBy?.rule).toBe(FILMSTRIP_RULE)
      expect(clip.start).toBe(30)
    }
  })
})

/*
 * The row has to be on screen.
 *
 * The leftward case — which was the DEFAULT — laid the row already filling the
 * frame and then walked it away, so a filmstrip showed its photographs, drained
 * to none by the halfway point, and played black for the rest of its length.
 * Panels on screen went 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0. Nothing in the plan
 * looked wrong; you had to count what was actually visible.
 */
describe('the row crosses the frame', () => {
  const DURATION = 120

  /** Panels overlapping the frame at a moment. A panel spans centre ± width. */
  const onScreen = (panels: ReturnType<typeof planFilmstrip>, frame: number): number =>
    panels.filter((p) => {
      const at = pathAt(p.path, frame, DURATION)!
      return at.x + p.width > -1 && at.x - p.width < 1
    }).length

  for (const direction of ['left', 'right'] as const) {
    describe(direction, () => {
      const panels = (): ReturnType<typeof planFilmstrip> =>
        planFilmstrip(images(4), DURATION, { visible: 4, direction })

      it('starts and ends with the frame clear', () => {
        expect(onScreen(panels(), 0)).toBe(0)
        expect(onScreen(panels(), DURATION)).toBe(0)
      })

      it('fills the frame in the middle', () => {
        expect(onScreen(panels(), DURATION / 2)).toBe(4)
      })

      it('never leaves the frame empty while it is running', () => {
        for (let f = Math.round(DURATION * 0.1); f <= DURATION * 0.9; f += 4) {
          expect(onScreen(panels(), f), `empty at frame ${f}`).toBeGreaterThan(0)
        }
      })

      it('shows the first photograph first', () => {
        // Laid in index order regardless of travel, a rightward strip plays the
        // set backwards.
        const laid = panels()
        const entry = laid.map((p) => {
          for (let f = 0; f <= DURATION; f++) {
            const at = pathAt(p.path, f, DURATION)!
            if (at.x + p.width > -1 && at.x - p.width < 1) return f
          }
          return Infinity
        })
        expect(entry[0]).toBeLessThan(entry[3])
      })
    })
  }

  it('behaves the same whichever way it travels', () => {
    const counts = (direction: 'left' | 'right'): number[] => {
      const laid = planFilmstrip(images(4), DURATION, { visible: 4, direction })
      return Array.from({ length: 11 }, (_, i) => onScreen(laid, (i * DURATION) / 10))
    }
    expect(counts('left')).toEqual(counts('right'))
  })
})
