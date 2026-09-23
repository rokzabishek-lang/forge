import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GRAPH_LEAST_SPAN,
  axisPosition,
  graphWindow,
  valueAtAxis,
  type Keyframe,
  type KeyedProperty
} from '@shared/render/keyframes'

/*
 * The keyframe graph (the Motion tab beside the timeline).
 *
 * Reported from the app: the graph was unreadable. Zoom's axis ran 1× to 4× and
 * rotation's a half-turn either way, so an ordinary push-in or tilt was a flat
 * line on the floor; the property tabs fell off the header; keys on the edge
 * were half cut off; and the axis limits were labelled as if they were the
 * clip's start and end values.
 */

const keys = (...values: number[]): Keyframe[] =>
  values.map((value, i) => ({ frame: i * 30, value, ease: 'smooth' as const }))

/** Where a value sits in the window, 0 at the bottom and 1 at the top. */
const inWindow = (property: KeyedProperty, value: number, keysIn: Keyframe[]): number => {
  const { lo, hi } = graphWindow(property, keysIn)
  return (axisPosition(property, value) - lo) / (hi - lo)
}

describe('the graph’s window', () => {
  it('fits an ordinary push-in so it fills the graph', () => {
    const k = keys(1, 1.4, 1.1)
    // It used to sit 13% of the way up; now well over half.
    expect(inWindow('zoom', 1.4, k)).toBeGreaterThan(0.5)
    expect(inWindow('zoom', 1.4, k)).toBeLessThan(1)
    expect(inWindow('zoom', 1, k)).toBeGreaterThanOrEqual(0)
  })

  it('leaves room above the highest key to drag into', () => {
    for (const k of [keys(1, 1.4), keys(1, 3), keys(0.9, 2.2, 1.5)]) {
      expect(inWindow('zoom', Math.max(...k.map((x) => x.value)), k)).toBeLessThanOrEqual(0.9)
    }
    expect(inWindow('rotation', 8, keys(0, 8, -4))).toBeLessThanOrEqual(0.9)
    expect(inWindow('rotation', -4, keys(0, 8, -4))).toBeGreaterThanOrEqual(0.1)
  })

  it('always shows the neutral value, so "no change" has its line', () => {
    expect(inWindow('rotation', 0, keys(40, 60))).toBeGreaterThanOrEqual(0)
    expect(inWindow('rotation', 0, keys(40, 60))).toBeLessThanOrEqual(1)
    expect(inWindow('zoom', 1, keys(2.5, 3))).toBeGreaterThanOrEqual(0)
  })

  it('is never narrower than the least span, even with nothing keyed', () => {
    for (const property of ['zoom', 'rotation'] as const) {
      for (const k of [[], keys(1), keys(1.2, 1.2)]) {
        const { lo, hi } = graphWindow(property, property === 'rotation' ? k.map((x) => ({ ...x, value: 0 })) : k)
        expect(valueAtAxis(property, hi) - valueAtAxis(property, lo), property).toBeGreaterThanOrEqual(
          GRAPH_LEAST_SPAN[property]! - 1e-9
        )
      }
    }
  })

  it('slides inside the property’s range rather than shrinking against its limit', () => {
    const top = graphWindow('zoom', keys(3.9, 4))
    expect(top.hi).toBe(1)
    expect(valueAtAxis('zoom', top.hi) - valueAtAxis('zoom', top.lo)).toBeGreaterThanOrEqual(0.5)
    const floor = graphWindow('zoom', keys(1, 1.05))
    expect(floor.lo).toBe(0)
  })

  it('keeps opacity and volume on their whole axis — volume must match the fader', () => {
    expect(graphWindow('opacity', keys(0.9, 1))).toEqual({ lo: 0, hi: 1 })
    expect(graphWindow('volume', keys(0.5, 1))).toEqual({ lo: 0, hi: 1 })
  })

  it('ignores a key that is not a number', () => {
    expect(graphWindow('zoom', keys(1, Number.NaN, 1.4))).toEqual(graphWindow('zoom', keys(1, 1.4)))
  })
})

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('the graph panel', () => {
  const panel = source('src/renderer/src/components/CurvePanel.tsx')
  const editor = source('src/renderer/src/components/CurveEditor.tsx')

  it('gives the property tabs a row of their own that wraps, not the fixed-height header', () => {
    const header = panel.slice(panel.indexOf('flex h-7 shrink-0'), panel.indexOf('The properties on a row of their own'))
    expect(header).not.toContain('KEYED_PROPERTIES')
    const row = panel.slice(panel.indexOf('The properties on a row of their own'))
    expect(row.slice(0, row.indexOf('KEYED_PROPERTIES.map'))).toContain('flex-wrap')
  })

  it('draws against the fitted window, frozen while a point is dragged or a line drawn', () => {
    expect(editor).toContain('const view = frozen ?? graphWindow(property, points)')
    // Frozen at the start of both gestures, released at the end of both.
    expect([...editor.matchAll(/setFrozen\(view\)/g)]).toHaveLength(2)
    expect([...editor.matchAll(/setFrozen\(null\)/g)]).toHaveLength(2)
  })

  it('insets the plot so a key on the edge is whole', () => {
    expect(editor).toMatch(/const PAD = [1-9]\d*/)
    expect(editor).toContain('const toX = (frame: number): number => PAD + (frame / span) * plotW')
  })

  it('no longer labels the axis limits as the clip’s start and end values', () => {
    expect(editor).not.toMatch(/valueAtAxis\(property, 0\)\)\} · start/)
    expect(editor).toContain('clip start')
  })
})
