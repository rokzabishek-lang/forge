import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_KEY,
  PIXEL_U,
  PIXEL_V,
  chromaDistance,
  chromakeyFilter,
  despillFilter,
  despillPixel,
  isKeyable,
  keyAlpha,
  keyChroma,
  pickRegion,
  pickedColor,
  pixelChroma,
  saneKey,
  screenOf,
  type ChromaKey
} from '@shared/render/chromaKey'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Chroma key (FIX.md B3) — the model, the store, and the wiring.
 *
 * The model is tied to ffmpeg by tests/integration/chromaKey.int.test.ts, which
 * runs the real chromakey over patches and checks every alpha. These pin the
 * pieces that test does not reach: the exact numbers, the ranges, the pick,
 * and that the plan, the shader and the preview are each wired to them.
 */

const green: ChromaKey = { color: '#00ff00', similarity: 0.1, blend: 0.1, despill: 0.5 }

describe('the key colour and the pixel are converted differently, as ffmpeg does', () => {
  it('keys pure green at (44, 21): the JPEG formula in fixed point', () => {
    expect(keyChroma('#00ff00')).toEqual([44, 21])
  })

  it('reads a pure green pixel at (54, 34): BT.601 limited range', () => {
    expect(pixelChroma(0, 255, 0)).toEqual([54, 34])
    // Neutral is neutral in both.
    expect(pixelChroma(128, 128, 128)).toEqual([128, 128])
    expect(keyChroma('#808080')).toEqual([128, 128])
  })

  it('pixelChroma reads the shared coefficients the shader is written from', () => {
    const [r, g, b] = [30, 200, 90]
    const u = 128 + PIXEL_U[0] * r + PIXEL_U[1] * g + PIXEL_U[2] * b
    const v = 128 + PIXEL_V[0] * r + PIXEL_V[1] * g + PIXEL_V[2] * b
    expect(pixelChroma(r, g, b)).toEqual([Math.round(u), Math.round(v)])
  })

  it('takes a bad colour as the default green rather than as black', () => {
    expect(keyChroma('not a colour')).toEqual(keyChroma(DEFAULT_KEY.color))
  })
})

describe('distance and alpha', () => {
  it('is 0 on the key and grows away from it', () => {
    expect(chromaDistance(44, 21, [44, 21])).toBe(0)
    expect(chromaDistance(54, 34, [44, 21])).toBeGreaterThan(0)
    expect(chromaDistance(255, 0, [0, 255])).toBeCloseTo(1, 9)
  })

  it('truncates a soft edge, and cuts hard at blend 0', () => {
    // 100.7 of the way up: truncated to 100, where rounding would say 101. Not
    // a half — 0.5 of the blend is 127.4999… in floating point and rounds down
    // too, which is how a first version of this test passed with Math.round.
    expect(keyAlpha(0.1 + 0.1 * (100.7 / 255), 0.1, 0.1)).toBe(100)
    expect(keyAlpha(0.05, 0.1, 0.1)).toBe(0)
    expect(keyAlpha(0.5, 0.1, 0.1)).toBe(255)
    expect(keyAlpha(0.1, 0.1, 0)).toBe(0)
    expect(keyAlpha(0.1001, 0.1, 0)).toBe(255)
  })
})

describe('a stored key, brought into range', () => {
  it('clamps every number and normalises the colour', () => {
    expect(saneKey({ color: '#00FF00', similarity: 9, blend: -1, despill: 2 })).toEqual({
      color: '#00ff00',
      similarity: 0.5,
      blend: 0,
      despill: 1
    })
    expect(saneKey({ color: '00b140' }).color).toBe('#00b140')
    expect(saneKey({ similarity: Number.NaN }).similarity).toBe(0.01)
  })

  it('fills anything missing from the default', () => {
    expect(saneKey(undefined)).toEqual(DEFAULT_KEY)
    expect(saneKey({ color: 'blue' }).color).toBe(DEFAULT_KEY.color)
  })
})

describe('the export’s filters', () => {
  it('writes chromakey with the colour as hex and fixed decimals', () => {
    expect(chromakeyFilter(green)).toBe('chromakey=color=0x00ff00:similarity=0.1000:blend=0.1000')
  })

  it('despills the screen it is keying, by a negative amount, or not at all', () => {
    expect(despillFilter(green)).toBe('despill=type=green:mix=0.5:expand=0:green=-0.5000')
    expect(despillFilter({ ...green, color: '#0000ff' })).toBe('despill=type=blue:mix=0.5:expand=0:blue=-0.5000')
    expect(despillFilter({ ...green, despill: 0 })).toBeNull()
    expect(screenOf('#2050e0')).toBe('blue')
    expect(screenOf('#00b140')).toBe('green')
  })

  it('despills one pixel the way ffmpeg does', () => {
    // spill = g − (r+b)/2 = 20; all of it out at full strength.
    expect(despillPixel(120, 140, 120, { ...green, despill: 1 })).toEqual([120, 120, 120])
    expect(despillPixel(120, 140, 120, { ...green, despill: 0.5 })).toEqual([120, 130, 120])
    // The mix is the MEAN of the other two, not either one: 180 − (100+60)/2 = 100.
    expect(despillPixel(100, 180, 60, { ...green, despill: 1 })).toEqual([100, 80, 60])
    // Blue the same way: 180 − (60+100)/2 = 100 of spill, 80 left.
    expect(despillPixel(60, 100, 180, { ...green, color: '#0000ff', despill: 1 })).toEqual([60, 100, 80])
    // Nothing above the mix, nothing taken.
    expect(despillPixel(200, 100, 200, { ...green, despill: 1 })).toEqual([200, 100, 200])
    expect(despillPixel(0, 0, 200, { ...green, color: '#0000ff', despill: 1 })).toEqual([0, 0, 0])
  })
})

describe('what can be keyed', () => {
  const video = { kind: 'video', hasVideo: true } as const
  it('is footage and photographs', () => {
    expect(isKeyable({}, video)).toBe(true)
    expect(isKeyable({}, { kind: 'image', hasVideo: true })).toBe(true)
  })
  it('is not what the app draws, an adjustment layer, sound, or nothing', () => {
    for (const drawn of [{ text: {} }, { title: {} }, { paper: {} }, { carousel: {} }, { solid: {} }, { adjustment: true }]) {
      expect(isKeyable(drawn as Parameters<typeof isKeyable>[0], video), JSON.stringify(drawn)).toBe(false)
    }
    expect(isKeyable({}, { kind: 'audio', hasVideo: false })).toBe(false)
    expect(isKeyable({}, undefined)).toBe(false)
  })
})

describe('the pick', () => {
  it('averages the opaque pixels under the click', () => {
    const rgba = [0, 170, 60, 255, 0, 180, 70, 255, 255, 0, 0, 10]
    expect(pickedColor(rgba)).toBe('#00af41')
  })
  it('has nothing to pick from pixels that are all see-through', () => {
    expect(pickedColor([0, 255, 0, 0, 0, 255, 0, 40])).toBeNull()
    expect(pickedColor([])).toBeNull()
  })
  it('samples a square round the click, kept inside the picture', () => {
    expect(pickRegion(50, 40, 100, 100)).toEqual({ x: 47, y: 37, width: 7, height: 7 })
    expect(pickRegion(0.4, 99.9, 100, 100)).toEqual({ x: 0, y: 96, width: 4, height: 4 })
    expect(pickRegion(-1, 5, 100, 100)).toBeNull()
    expect(pickRegion(100, 5, 100, 100)).toBeNull()
  })
})

/* ---------------------------------------------------------------- wiring */

function keyedProject(over: Partial<Clip> = {}): Project {
  const asset = (id: string, kind: MediaAsset['kind']): MediaAsset => ({
    id, path: `/m/${id}.png`, name: id, kind, durationFrames: 30, width: 320, height: 180,
    fps: kind === 'video' ? 30 : null, hasVideo: true, hasAudio: false, size: 1
  })
  const clip = (id: string, assetId: string, trackId: string, extra: Partial<Clip> = {}): Clip => ({
    id, assetId, trackId, start: 0, duration: 15, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }, ...extra
  })
  return {
    ...emptyProject(),
    settings: { ...emptyProject().settings, width: 320, height: 180, fps: 30 },
    assets: [asset('bg', 'video'), asset('top', 'image')],
    clips: [clip('bg', 'bg', 'v1'), clip('top', 'top', 'v2', { key: DEFAULT_KEY, ...over })]
  }
}

const graphOf = (p: Project): string => {
  const args = buildRenderPlan({ project: p, outputPath: '/o.mp4' }).args
  return args[args.indexOf('-filter_complex') + 1]
}

describe('the plan keys the ungraded, fitted picture and multiplies it into the clip’s own alpha', () => {
  it('builds the whole key in order, before anything grades the picture', () => {
    const graph = graphOf(keyedProject({ color: { brightness: 0.1, contrast: 1, saturation: 1, temperature: 0.4 } }))
    const steps = [
      'format=yuva420p,split=3[kp1][ko1][kc1]',
      `[kc1]${chromakeyFilter(DEFAULT_KEY)},alphaextract[kk1]`,
      '[ko1]alphaextract[kn1]',
      '[kn1][kk1]blend=all_mode=multiply[ka1]',
      '[kp1][ka1]alphamerge[kd1]',
      `[kd1]${despillFilter(DEFAULT_KEY)},colorchannelmixer=`
    ]
    let at = -1
    for (const step of steps) {
      const next = graph.indexOf(step, at + 1)
      expect(next, step).toBeGreaterThan(at)
      at = next
    }
    // Nothing graded before the key is measured.
    const keyedChain = graph.split(';').find((f) => f.includes('split=3[kp1]'))!
    expect(keyedChain).not.toMatch(/eq=|colorchannelmixer|curves=|lut3d/)
  })

  it('is not also a late stencil shape — that is what failed a turned keyed clip', () => {
    const graph = graphOf(keyedProject())
    // [kk1] is consumed exactly once, by the multiply into the clip's own alpha.
    expect([...graph.matchAll(/\[kk1\]/g)]).toHaveLength(2)
    expect(graph).not.toContain('[ma1]')
  })

  it('leaves an unkeyed clip without any of it', () => {
    const graph = graphOf(keyedProject({ key: undefined }))
    expect(graph).not.toMatch(/chromakey|despill|split=3/)
  })
})

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('the Inspector offers the key where it can work', () => {
  const inspector = source('src/renderer/src/components/Inspector.tsx')
  const panel = source('src/renderer/src/components/KeyPanel.tsx')

  it('shows the Key panel only for a keyable clip, between the mask and the colour', () => {
    const at = inspector.indexOf('{isKeyable(clip, asset ?? undefined) && <KeyPanel clip={clip} />}')
    expect(at).toBeGreaterThan(inspector.indexOf('<MaskPanel clip={clip} />'))
    expect(at).toBeLessThan(inspector.indexOf('onClick={() => setColor(clip.id, NEUTRAL_COLOR_PATCH)}'))
    expect([...inspector.matchAll(/<KeyPanel /g)]).toHaveLength(1)
  })

  it('starts from the default key and goes straight to picking', () => {
    expect(panel).toContain('setKey(clip.id, DEFAULT_KEY)')
    expect(panel).toContain("setPreviewTool('key')")
  })
})

describe('the preview keys the same way', () => {
  const grade = source('src/renderer/src/grade.ts')

  it('writes the shared chroma coefficients into the shader, not a second copy', () => {
    expect(grade).toContain('${chromaRow(PIXEL_U)}')
    expect(grade).toContain('${chromaRow(PIXEL_V)}')
    expect(grade).not.toContain('0.1482')
    expect(grade).not.toContain('0.3678')
  })

  it('keys before white balance, and multiplies into the picture’s own alpha', () => {
    const key = grade.indexOf('if (uKeyOn > 0.5) {')
    expect(key).toBeGreaterThan(-1)
    expect(key).toBeLessThan(grade.indexOf('rgb = clamp(rgb * uGains, 0.0, 1.0);'))
    expect(grade).toContain('fragColor = vec4(graded, src.a * keep);')
  })

  it('hands the shader the key colour the way ffmpeg converts it', () => {
    expect(grade).toContain('const [u, v] = keyChroma(k.color)')
    expect(grade).toContain('gl.uniform2f(uniforms.uKeyUv, u, v)')
  })

  it('passes each clip’s key at BOTH of the preview’s grading sites', () => {
    const preview = source('src/renderer/src/components/Preview.tsx')
    // Every call, not the first one found: there are two, and each must pass it.
    const calls = preview.split('\n').filter((line) => line.includes('gradedSource(') && !line.includes('import'))
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.trim()).toMatch(/layer\.clip\.key\),?$/)
  })

  it('draws the clip raw while its screen colour is being picked', () => {
    const preview = source('src/renderer/src/components/Preview.tsx')
    expect(preview).toMatch(/raw\s*\?\s*sourceFor\(layer\)\s*:\s*gradedSource\(sourceFor\(layer\)/)
    expect(preview).toMatch(/raw\s*\?\s*plane\.element\s*:\s*gradedSource\(plane\.element/)
    expect(preview).toContain("previewTool === 'key'")
  })
})
