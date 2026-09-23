import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FRAME_RATES, convertFrame, convertFrameRate } from '@shared/project/frameRate'
import { NEW_PROJECT_RATES } from '@shared/project/newProject'
import { clipEnd, emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { sourceFramesFor } from '@shared/render/speed'

/*
 * Changing the frame rate of a project with work in it (FIX.md B2).
 *
 * Frames are the model's unit, so this is arithmetic — but every frame-valued
 * field has to be found, and lengths must come from converted BOUNDARIES so
 * shots that touched still touch.
 */

const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, path: `/m/${id}.mp4`, name: id, kind: 'video', durationFrames: 300,
  width: 1920, height: 1080, fps: 29.97, hasVideo: true, hasAudio: true, size: 1, ...over
})
const clip = (over: Partial<Clip> & { id: string }): Clip => ({
  assetId: 'a', trackId: 'v1', start: 0, duration: 90, inPoint: 0, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
})
function project(clips: Clip[], assets: MediaAsset[] = [asset('a')], fps = 30): Project {
  const empty = emptyProject()
  return { ...empty, settings: { ...empty.settings, fps }, assets, clips }
}
const byId = (p: Project, id: string): Clip => p.clips.find((c) => c.id === id)!

describe('changing the frame rate', () => {
  it('keeps shots that touched touching, and every cut where it was in seconds', () => {
    // Lengths that do not divide evenly: rounding each alone opens gaps.
    const shots = [clip({ id: 'a', start: 0, duration: 37 }), clip({ id: 'b', start: 37, duration: 41 }),
      clip({ id: 'c', start: 78, duration: 29 })]
    for (const to of FRAME_RATES) {
      const out = convertFrameRate(project(shots), to)
      expect(byId(out, 'b').start, `${to}`).toBe(clipEnd(byId(out, 'a')))
      expect(byId(out, 'c').start, `${to}`).toBe(clipEnd(byId(out, 'b')))
      for (const s of shots) {
        const moved = Math.abs(byId(out, s.id).start / to - s.start / 30)
        expect(moved, `${s.id} at ${to}`).toBeLessThanOrEqual(0.5 / to + 1e-9)
      }
      expect(out.settings.fps).toBe(to)
    }
  })

  it('converts every frame-valued field on a clip', () => {
    const full = clip({
      id: 'x', start: 30, duration: 60, inPoint: 90, fadeIn: 15, fadeOut: 12,
      transitionIn: { id: 'dissolve', durationFrames: 10 },
      directorTrim: { duration: 120, fadeOut: 6 },
      keyframes: { zoom: [{ frame: 0, value: 1 }, { frame: 60, value: 1.5 }] },
      path: [{ frame: 0, x: 0, y: 0 }, { frame: 30, x: 0.5, y: 0 }],
      paper: { holdFrames: 6 } as NonNullable<Clip['paper']>
    })
    const out = byId(convertFrameRate(project([full]), 25), 'x')
    expect(out.start).toBe(25)
    expect(out.duration).toBe(50)
    expect(out.inPoint).toBe(75)
    expect(out.fadeIn).toBe(13) // 12.5 → 13
    expect(out.fadeOut).toBe(10)
    expect(out.transitionIn?.durationFrames).toBe(8)
    expect(out.directorTrim).toEqual({ duration: 100, fadeOut: 5 })
    expect(out.keyframes?.zoom?.map((k) => k.frame)).toEqual([0, 50])
    expect(out.path?.map((p) => p.frame)).toEqual([0, 25])
    expect(out.paper?.holdFrames).toBe(5)
  })

  it('converts an asset’s length, and leaves its own rate and everything in seconds alone', () => {
    const p: Project = {
      ...project([clip({ id: 'x' })], [asset('a', { durationFrames: 300, fps: 29.97 })]),
      transcripts: { a: { words: [{ index: 0, text: 'hi', startMs: 1200, endMs: 1500, confidence: 1 }] } as never }
    }
    const out = convertFrameRate(p, 24)
    expect(out.assets[0].durationFrames).toBe(240)
    // The FILE's rate is a fact about the file.
    expect(out.assets[0].fps).toBe(29.97)
    // Transcripts are milliseconds into the source — never frames.
    expect(out.transcripts).toBe(p.transcripts)
  })

  it('never has a clip read past the end of its file, at speed', () => {
    // 2× reading exactly to the end of a 300-frame file. At 25 fps the in-point
    // (166.7) and the length (41.7) both round UP, asking for 251 frames of 250.
    const fast = clip({ id: 'f', start: 0, duration: 50, inPoint: 200, speed: 2 })
    const src = asset('a', { durationFrames: 300 })
    for (const to of FRAME_RATES) {
      const out = convertFrameRate(project([fast], [src]), to)
      const c = byId(out, 'f')
      expect(c.inPoint + sourceFramesFor(c), `${to}`).toBeLessThanOrEqual(out.assets[0].durationFrames)
    }
  })

  it('keeps a crossfade’s overlap', () => {
    const p = project([clip({ id: 'a', start: 0, duration: 60 }), clip({ id: 'b', start: 45, duration: 60 })])
    const out = convertFrameRate(p, 25)
    // 15 frames at 30 is half a second; at 25 it is 12.5 → 12 or 13.
    const overlap = clipEnd(byId(out, 'a')) - byId(out, 'b').start
    expect(Math.abs(overlap / 25 - 0.5)).toBeLessThanOrEqual(1 / 25)
  })

  it('comes back within a frame from a round trip', () => {
    const p = project([clip({ id: 'a', start: 17, duration: 43, inPoint: 11, fadeIn: 7 })])
    const back = byId(convertFrameRate(convertFrameRate(p, 25), 30), 'a')
    expect(Math.abs(back.start - 17)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.duration - 43)).toBeLessThanOrEqual(1)
    expect(Math.abs((back.fadeIn ?? 0) - 7)).toBeLessThanOrEqual(1)
  })

  it('returns the same project for the same rate, or a rate that is not one', () => {
    const p = project([clip({ id: 'a' })])
    for (const bad of [30, 0, -24, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(convertFrameRate(p, bad), String(bad)).toBe(p)
    }
    expect(convertFrame(90, 30, 25)).toBe(75)
  })

  it('handles every field the model types as Frames — a new one cannot be forgotten', () => {
    /*
     * The conversion is only as good as its list, so the list is checked
     * against the model: every field declared `: Frames` in timeline.ts must be
     * named in frameRate.ts. Add one to the model and this fails until it is
     * converted too.
     */
    const model = readFileSync(resolve(__dirname, '../src/shared/timeline.ts'), 'utf8')
    const converter = readFileSync(resolve(__dirname, '../src/shared/project/frameRate.ts'), 'utf8')
    const declared = new Set<string>()
    // Fields of the model's interfaces only — a function's `desired: Frames`
    // parameter is not something a project stores.
    for (const [, body] of model.matchAll(/export interface \w+[^{]*\{([\s\S]*?)\n\}/g)) {
      for (const m of body.matchAll(/(\w+)\??:\s*Frames\b/g)) declared.add(m[1])
    }
    expect(declared.size).toBeGreaterThan(5)
    for (const field of declared) {
      expect(converter.includes(field), `${field} is typed Frames but frameRate.ts never mentions it`).toBe(true)
    }
  })
})

describe('the rates are offered where the rate is chosen', () => {
  it('New Project offers exactly the rates the Output panel converts between', () => {
    expect(NEW_PROJECT_RATES.map((r) => r.fps).sort((a, b) => a - b)).toEqual([...FRAME_RATES])
    // 30 stays first — what phones shoot, and the default.
    expect(NEW_PROJECT_RATES[0].fps).toBe(30)
  })

  it('changing it in the editor converts the project and moves the playhead and marks with it', () => {
    const store = readFileSync(resolve(__dirname, '../src/renderer/src/store.ts'), 'utf8')
    const at = store.indexOf('  setFrameRate: (fps) => {')
    expect(at).toBeGreaterThan(-1)
    const action = store.slice(at, store.indexOf('\n  },\n', at))
    expect(action).toContain('const next = convertFrameRate(project, fps)')
    expect(action).toContain('get().update(() => next)')
    expect(action).toContain('playhead: at(playhead),')
    expect(action).toContain('rangeIn: rangeIn === null ? null : at(rangeIn),')
    expect(action).toContain('rangeOut: rangeOut === null ? null : at(rangeOut),')
    expect(action).toContain('void get().rebakeGenerated()')
    const inspector = readFileSync(resolve(__dirname, '../src/renderer/src/components/Inspector.tsx'), 'utf8')
    expect(inspector).toContain('onClick={() => setFrameRate(rate)}')
  })
})
