import { describe, it, expect } from 'vitest'
import {
  NEW_PROJECT_ASPECTS,
  NEW_PROJECT_RATES,
  NEW_PROJECT_DEFAULT,
  projectFromChoice
} from '@shared/project/newProject'
import { ASPECTS } from '@shared/render/aspect'
import { emptyProject } from '@shared/timeline'

describe('the first decision', () => {
  it('offers vertical FIRST', () => {
    /*
     * Not a detail. This app is for reels, product demos and short-form ads,
     * and a list that puts landscape first teaches that landscape is the normal
     * answer — which is how every project ended up 1920x1080 and found out at
     * export. `DEFAULT_SETTINGS` is still landscape for everything that does
     * not ask; this screen is the thing that asks.
     */
    expect(NEW_PROJECT_ASPECTS[0].key).toBe('9:16')
    expect(NEW_PROJECT_DEFAULT.aspect).toBe('9:16')
  })

  it('offers only aspects that exist, each with a reason', () => {
    for (const { key, hint } of NEW_PROJECT_ASPECTS) {
      expect(ASPECTS[key], key).toBeDefined()
      // A bare "1:1" makes someone work out what it is for.
      expect(hint.length, key).toBeGreaterThan(3)
    }
    expect(new Set(NEW_PROJECT_ASPECTS.map((a) => a.key)).size).toBe(NEW_PROJECT_ASPECTS.length)
  })

  it('offers 30fps first, which is what phones shoot', () => {
    expect(NEW_PROJECT_RATES[0].fps).toBe(30)
    expect(NEW_PROJECT_DEFAULT.fps).toBe(30)
  })
})

describe('building the project from the answers', () => {
  it('uses the chosen shape and rate', () => {
    /*
     * Every shape, not just the default one. Testing 9:16 alone cannot tell
     * "uses what was chosen" from "always uses the default" — they are the
     * same answer, and the mutation run found the test passing with the choice
     * thrown away entirely.
     */
    for (const { key } of NEW_PROJECT_ASPECTS) {
      const p = projectFromChoice({ name: 'Ad', aspect: key, fps: 24 })
      expect(p.name).toBe('Ad')
      expect(p.settings.width, key).toBe(ASPECTS[key].width)
      expect(p.settings.height, key).toBe(ASPECTS[key].height)
      expect(p.settings.fps).toBe(24)
    }
  })

  it('is an ordinary new project in every other way', () => {
    /*
     * Built on `emptyProject` rather than beside it, so a project made here and
     * one made any other way are the same object — the tracks, the caption
     * defaults and the loudness target included, none of which this screen asks
     * about because none is worth a question.
     */
    const made = projectFromChoice({ aspect: '16:9', fps: 30 })
    const plain = emptyProject()
    expect(made.tracks.map((t) => t.id)).toEqual(plain.tracks.map((t) => t.id))
    expect(made.captions).toEqual(plain.captions)
    expect(made.settings.sampleRate).toBe(plain.settings.sampleRate)
    expect(made.settings.loudness).toBe(plain.settings.loudness)
    expect(made.id).toBeTruthy()
    expect(made.id).not.toBe(plain.id)
  })

  it('falls back rather than trusting a value it was handed', () => {
    // The choice comes from an interface today and could come from a template
    // or a command line later; an unknown aspect must not reach ffmpeg.
    const p = projectFromChoice({ aspect: '4:3' as never, fps: 999, name: '   ' })
    expect(p.settings.width).toBe(ASPECTS[NEW_PROJECT_DEFAULT.aspect].width)
    expect(p.settings.fps).toBe(NEW_PROJECT_DEFAULT.fps)
    expect(p.name).toBe(NEW_PROJECT_DEFAULT.name)
  })

  it('trims a name rather than saving the spaces around it', () => {
    expect(projectFromChoice({ name: '  Wedding  ' }).name).toBe('Wedding')
  })
})
