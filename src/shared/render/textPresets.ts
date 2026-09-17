import type { TextSpec } from '../timeline'

/**
 * Text looks, in one click.
 *
 * The panel had ten sliders and no starting points, which is the slowest
 * possible way to get a decent title: every one of those sliders is a decision,
 * and most of them only read well in combination. A preset is that combination,
 * already made.
 *
 * Each is a real typographic convention rather than a random set of numbers, and
 * the notes say which — so changing one later is an argument about the craft
 * rather than a guess.
 */

export interface TextPreset {
  id: string
  name: string
  /** What it is for, in the words someone choosing would use. */
  description: string
  spec: Partial<Omit<TextSpec, 'version' | 'content'>>
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: 'title',
    name: 'Title',
    description: 'Wide capitals, centred. The film-title look.',
    spec: {
      size: 0.1,
      weight: 700,
      // Wide tracking with capitals is the single biggest lever on whether type
      // reads as cinematic rather than as a caption.
      tracking: 0.16,
      uppercase: true,
      align: 'center',
      position: 'center',
      color: '#f5f2ec',
      shadow: 0.55,
      stroke: 0
    }
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    description: 'Name-and-role, bottom left. Quiet and factual.',
    spec: {
      size: 0.055,
      weight: 600,
      tracking: 0.02,
      uppercase: false,
      align: 'left',
      position: 'lower',
      color: '#ffffff',
      shadow: 0.7,
      stroke: 0
    }
  },
  {
    id: 'impact',
    name: 'Impact',
    description: 'Heavy with a hard outline. Reads on any background.',
    spec: {
      size: 0.11,
      weight: 800,
      // Tight, because a heavy face with wide tracking reads as loose rather
      // than as loud.
      tracking: -0.01,
      uppercase: true,
      align: 'center',
      position: 'center',
      color: '#ffffff',
      // An outline is what survives a busy frame; the shadow comes down so the
      // two do not fight.
      stroke: 0.07,
      strokeColor: '#000000',
      shadow: 0.25
    }
  },
  {
    id: 'quote',
    name: 'Quote',
    description: 'Light, open, no shouting. For a line worth reading slowly.',
    spec: {
      size: 0.062,
      weight: 400,
      tracking: 0.06,
      uppercase: false,
      align: 'center',
      position: 'center',
      color: '#f2efe9',
      shadow: 0.4,
      stroke: 0
    }
  },
  {
    id: 'sticker',
    name: 'Sticker',
    description: 'Small, outlined, sits in a corner like a label.',
    spec: {
      size: 0.045,
      weight: 700,
      tracking: 0.04,
      uppercase: true,
      align: 'center',
      position: 'top',
      color: '#ffe8b0',
      stroke: 0.1,
      strokeColor: '#1a1207',
      shadow: 0
    }
  }
]

export function textPresetById(id: string): TextPreset | undefined {
  return TEXT_PRESETS.find((p) => p.id === id)
}

/**
 * Which preset a spec currently matches, if any.
 *
 * Only the fields the preset actually sets are compared — a preset says nothing
 * about the words or the font, so changing either must not stop it being
 * recognised.
 */
export function matchingPreset(spec: TextSpec): TextPreset | undefined {
  return TEXT_PRESETS.find((preset) =>
    (Object.keys(preset.spec) as (keyof TextPreset['spec'])[]).every((key) => {
      const wanted = preset.spec[key]
      const actual = spec[key as keyof TextSpec]
      if (typeof wanted === 'number' && typeof actual === 'number') {
        return Math.abs(wanted - actual) < 0.0005
      }
      return wanted === actual
    })
  )
}
