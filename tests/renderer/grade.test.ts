import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canvasContentKey } from '../../src/renderer/src/grade'

/*
 * A look over a canvas-drawn clip must not freeze it.
 *
 * Reported from the app: a look applied to the newspaper clippings from the
 * right-click menu, and the preview stopped moving — the look was there, the
 * pages no longer cut — while the export played. The grade caches its output
 * per clip and asks the source what changed; a canvas answered with its SIZE,
 * which never changes, because the paper and photo-ring canvases never said
 * otherwise.
 */

describe('the grade’s key for a canvas', () => {
  it('is the canvas’s own stamp when it has one, so an unchanged picture is not regraded', () => {
    expect(canvasContentKey('page-3')).toBe('page-3')
    expect(canvasContentKey('page-3')).toBe(canvasContentKey('page-3'))
  })

  it('never repeats for a canvas with no stamp, so it is never served stale', () => {
    const keys = new Set(Array.from({ length: 5 }, () => canvasContentKey(undefined)))
    expect(keys.size).toBe(5)
  })
})

const source = (path: string): string => readFileSync(resolve(__dirname, '../..', path), 'utf8')

describe('the canvases that animate say when they changed', () => {
  it('the paper run stamps each page it draws', () => {
    const paper = source('src/renderer/src/paperCanvas.ts')
    const at = paper.indexOf('drawPaperOnto(ctx, spec, width, height, { frame }, canvasMeasure(ctx))')
    expect(at).toBeGreaterThan(-1)
    // After the draw, before the cache entry — the stamp is of THIS page.
    expect(paper.slice(at, paper.indexOf('previews.set(clipId, { signature, canvas })', at))).toContain(
      'canvas.dataset.forgeRev = signature'
    )
  })

  it('the photo ring stamps every frame it paints', () => {
    const ring = source('src/renderer/src/carouselCanvas.ts')
    const at = ring.indexOf('async function paint(')
    expect(at).toBeGreaterThan(-1)
    expect(ring.slice(at, ring.indexOf('\n}\n', at))).toContain('target.dataset.forgeRev = String(++paints)')
  })
})

describe('the preview applies white balance the way the export does', () => {
  const grade = source('src/renderer/src/grade.ts')

  it('multiplies by the gains first, in RGB, before the sliders', () => {
    const gains = grade.indexOf('rgb = clamp(rgb * uGains, 0.0, 1.0);')
    expect(gains).toBeGreaterThan(-1)
    expect(gains).toBeLessThan(grade.indexOf('vec3 yuv = RGB_TO_YUV * rgb;'))
  })

  it('sets the gains in both grading paths, from the shared function', () => {
    expect([...grade.matchAll(/setGains\(gl, uniforms\.uGains, color\)/g)]).toHaveLength(2)
    expect(grade).toContain('const { r, g, b } = whiteBalanceGains(color.temperature, color.tint)')
  })

  it('keys the cached picture on the balance, so moving it repaints', () => {
    expect(grade).toContain('(color.temperature ?? 0).toFixed(4),')
    expect(grade).toContain('(color.tint ?? 0).toFixed(4),')
  })
})
