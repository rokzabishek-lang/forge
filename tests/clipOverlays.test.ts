import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * What a clip's overlays may take from the clip underneath.
 *
 * This guards a bug that shipped. The volume envelope was drawn as a
 * full-bleed `absolute inset-0 z-10` div with `onPointerDown` on it, which is
 * the obvious way to make a line clickable — and it made every clip with sound
 * in it completely immovable. No dragging along the timeline, no dragging to
 * another track, no trimming either edge, no selecting. One new control
 * silently took every gesture the clip already had, and the only sign was that
 * clicking a clip added a volume point instead of picking it up.
 *
 * It is asserted against the SOURCE rather than against a rendered component
 * because the failure is a CSS stacking and hit-testing one, and jsdom
 * implements neither. A test that mounted the component and checked
 * `elementFromPoint` would pass whatever the z-index said — a test certifying
 * the bug it was written to catch, which this project has collected four of.
 * The real check is a hit test in the harness; this is the cheap guard that
 * fails the moment someone writes the line again.
 */

const ROOT = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

describe('overlays drawn on a timeline clip', () => {
  it('lets pointers through the volume envelope to the clip underneath', () => {
    const source = read('src/renderer/src/components/VolumeEnvelope.tsx')
    // The box covering the whole clip must not be a hit target itself.
    expect(source).toMatch(/className="pointer-events-none absolute inset-0 z-10"/)
    expect(source).not.toMatch(/className="absolute inset-0 z-10"/)
  })

  it('takes pointers back only on the line and its points', () => {
    const source = read('src/renderer/src/components/VolumeEnvelope.tsx')
    // A transparent fat stroke is the grabbable line.
    expect(source).toMatch(/pointerEvents: 'stroke'/)
    // And the dots opt back in individually.
    expect(source).toMatch(/pointer-events-auto absolute rounded-full/)
  })

  it('never puts pointer events on the waveform at all', () => {
    // Scenery. If this ever takes a click it has the same effect as the bug
    // above, over the same area, for no benefit — there is nothing to click.
    const source = read('src/renderer/src/components/ClipWaveform.tsx')
    expect(source).toMatch(/pointer-events-none/)
    expect(source).not.toMatch(/onPointer|onClick|onMouse/)
  })

  it('keeps the trim handles above the envelope', () => {
    /*
     * The volume line runs the width of the clip, so it crosses both eight-pixel
     * trim strips. Whichever is on top wins there, and it has to be the trim
     * handle: adding a volume point is recoverable, and a clip whose edges
     * cannot be grabbed is not obviously broken — it just feels stuck.
     */
    const timeline = read('src/renderer/src/components/Timeline.tsx')
    const handles = timeline.match(/cursor-[we]-resize/g) ?? []
    expect(handles).toHaveLength(2)
    for (const side of ['left-0', 'right-0']) {
      const pattern = new RegExp(`absolute ${side} top-0 z-20 h-full w-2 cursor-[we]-resize`)
      expect(timeline).toMatch(pattern)
    }
    // …and the envelope is the z-10 it has to beat.
    expect(read('src/renderer/src/components/VolumeEnvelope.tsx')).toContain('z-10')
  })

  it('draws the waveform before the name, so the name is on top', () => {
    /*
     * Two things make the name readable, and both are load-bearing.
     *
     * The canvas comes first in the clip, AND the text sits in a `relative`
     * wrapper. Positioned boxes paint in document order regardless of what is
     * in flow, so an absolutely positioned canvas written after the text would
     * cover it — and a text wrapper that is not positioned loses to the canvas
     * wherever it is written. Either alone puts the filename under a waveform.
     */
    const timeline = read('src/renderer/src/components/Timeline.tsx')
    const wave = timeline.indexOf('<ClipWaveform')
    const name = timeline.indexOf("asset?.name ?? 'missing'")
    const envelope = timeline.indexOf('<VolumeEnvelope')
    expect(wave).toBeGreaterThan(-1)
    expect(wave).toBeLessThan(name)
    expect(name).toBeLessThan(envelope)
    expect(timeline).toMatch(/className="pointer-events-none relative">\s*\n\s*<div className="truncate/)
  })
})
