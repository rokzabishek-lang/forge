import { describe, it, expect } from 'vitest'
import { TEXT_PRESETS, matchingPreset, textPresetById } from '@shared/render/textPresets'
import { buildTextSvg } from '@shared/render/text'
import { layoutText } from '@shared/render/textLayout'
import { DEFAULT_TEXT, type TextSpec } from '@shared/timeline'

const spec = (over: Partial<TextSpec> = {}): TextSpec => ({ ...DEFAULT_TEXT, version: 1, ...over })

describe('TEXT_PRESETS', () => {
  it('has a unique id and a description for each', () => {
    expect(new Set(TEXT_PRESETS.map((p) => p.id)).size).toBe(TEXT_PRESETS.length)
    for (const preset of TEXT_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(2)
      expect(preset.description.length).toBeGreaterThan(10)
    }
  })

  it('never sets the words or the font', () => {
    // A preset is a look. Overwriting what someone typed would be unforgivable.
    for (const preset of TEXT_PRESETS) {
      expect(preset.spec).not.toHaveProperty('content')
      expect(preset.spec).not.toHaveProperty('font')
    }
  })

  it('produces a drawable spec for every preset', () => {
    for (const preset of TEXT_PRESETS) {
      const applied = spec({ ...preset.spec, content: 'HELLO' })
      const layout = layoutText(applied, 1080, 1920)
      expect(layout.fontPx).toBeGreaterThan(8)
      // Inside the frame, top and bottom.
      expect(layout.top).toBeGreaterThanOrEqual(0)
      expect(layout.top + layout.blockHeight).toBeLessThanOrEqual(1920)
      expect(buildTextSvg(applied, 1080, 1920)).toContain('<text')
    }
  })

  it('stays readable at a size that fits a phone', () => {
    // Under about 4% of frame height, type on a reel is unreadable.
    for (const preset of TEXT_PRESETS) {
      expect(preset.spec.size ?? 0.1).toBeGreaterThanOrEqual(0.04)
    }
  })

  it('gives an outlined preset something to outline with', () => {
    for (const preset of TEXT_PRESETS) {
      if ((preset.spec.stroke ?? 0) > 0) expect(preset.spec.strokeColor).toBeTruthy()
    }
  })

  it('actually emits a stroke when one is asked for', () => {
    // stroke and strokeColor were in the spec, drawn by both renderers, and
    // exposed by nothing at all until these presets.
    const impact = textPresetById('impact')!
    const svg = buildTextSvg(spec({ ...impact.spec, content: 'HELLO' }), 1080, 1920)
    expect(svg).toContain('stroke-width=')
    expect(svg).toContain('paint-order="stroke fill"')
  })

  it('offers looks that differ from one another', () => {
    // Five presets that all land in the same place would be one preset.
    const sizes = new Set(TEXT_PRESETS.map((p) => p.spec.size))
    expect(sizes.size).toBeGreaterThan(3)
  })
})

describe('matchingPreset', () => {
  it('recognises a spec it just applied', () => {
    for (const preset of TEXT_PRESETS) {
      expect(matchingPreset(spec(preset.spec))?.id).toBe(preset.id)
    }
  })

  it('ignores the words and the font, which a preset does not set', () => {
    const impact = textPresetById('impact')!
    const applied = spec({ ...impact.spec, content: 'anything', font: 'Bangers' })
    expect(matchingPreset(applied)?.id).toBe('impact')
  })

  it('stops matching once a value is changed by hand', () => {
    const impact = textPresetById('impact')!
    expect(matchingPreset(spec({ ...impact.spec, tracking: 0.3 }))?.id).not.toBe('impact')
  })
})
