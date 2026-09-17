import { describe, it, expect } from 'vitest'
import {
  findTriggerHits,
  inflectionsOf,
  normaliseToken,
  wordMatchesTag,
  tagsForProp,
  DEFAULT_TRIGGER_OPTIONS,
  type PropTrigger
} from '@shared/automation/keywords'
import { segmentIntoSentences, type Transcript, type Word } from '@shared/transcript'

function words(spec: [string, number][]): Word[] {
  return spec.map(([text, startMs], index) => ({
    index, text, startMs, endMs: startMs + 300, confidence: 0.9
  }))
}

function transcript(spec: [string, number][], durationMs = 60_000): Transcript {
  const w = words(spec)
  return { assetId: 'a1', language: 'en', model: 'test', durationMs, words: w, segments: segmentIntoSentences(w) }
}

const fire: PropTrigger = { assetId: 'fire', file: 'props_3d/fire_3d.png', name: 'fire', tags: tagsForProp('fire') }
const brain: PropTrigger = { assetId: 'brain', file: 'props_3d/brain_3d.png', name: 'brain', tags: tagsForProp('brain') }

const options = { ...DEFAULT_TRIGGER_OPTIONS, fps: 30 }

describe('token matching', () => {
  it('normalises case and punctuation without stemming', () => {
    expect(normaliseToken('Fire,')).toBe('fire')
    expect(normaliseToken('flames')).toBe('flames')
  })

  it('expands a tag into its inflections rather than stemming the word', () => {
    const forms = inflectionsOf('flame')
    expect(forms).toContain('flame')
    expect(forms).toContain('flames')
    // Silent e dropped before -ing.
    expect(forms).toContain('flaming')
    // "-ed" is excluded on purpose: "fired" is not "on fire".
    expect(forms).not.toContain('flamed')
  })

  it('doubles a final consonant, so "run" reaches "running"', () => {
    expect(inflectionsOf('run')).toContain('running')
  })

  it('matches whole tokens only — this is the false-positive guard', () => {
    expect(wordMatchesTag('fire', 'fire')).toBe(true)
    expect(wordMatchesTag('Fire!', 'fire')).toBe(true)
    expect(wordMatchesTag('flames', 'flame')).toBe(true)
    expect(wordMatchesTag('burning', 'burn')).toBe(true)
    // Substring matching would fire on both of these, which is the bug.
    expect(wordMatchesTag('fired', 'fire')).toBe(false)
    expect(wordMatchesTag('brainstorm', 'brain')).toBe(false)
    expect(wordMatchesTag('firefighter', 'fire')).toBe(false)
  })
})

describe('findTriggerHits', () => {
  it('fires on a matching word with its exact timing', () => {
    const hits = findTriggerHits(
      transcript([['this', 0], ['is', 500], ['fire', 1000]]),
      [fire],
      options
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ assetId: 'fire', wordIndex: 2, startMs: 1000 })
  })

  it('fires on a synonym, not just the prop name', () => {
    const hits = findTriggerHits(transcript([['pure', 0], ['genius', 400]]), [brain], options)
    expect(hits[0]?.assetId).toBe('brain')
    expect(hits[0]?.tag).toBe('genius')
  })

  it('records why it fired, so the user can see the reason', () => {
    const hits = findTriggerHits(transcript([['flames', 0]]), [fire], options)
    expect(hits[0].matchedWord).toBe('flames')
    expect(hits[0].tag).toBe('flame')
  })

  it('does not fire on a word that merely contains a tag', () => {
    const hits = findTriggerHits(
      transcript([['he', 0], ['got', 300], ['fired', 600], ['brainstorming', 900]]),
      [fire, brain],
      options
    )
    expect(hits).toEqual([])
  })

  it('enforces a cooldown so the same prop cannot machine-gun', () => {
    const hits = findTriggerHits(
      // Three fire words within a few seconds.
      transcript([['fire', 0], ['fire', 2000], ['fire', 4000]]),
      [fire],
      options
    )
    expect(hits).toHaveLength(1)
  })

  it('allows the same prop again after the cooldown', () => {
    const hits = findTriggerHits(
      transcript([['fire', 0], ['fire', 20_000]]),
      [fire],
      options
    )
    expect(hits).toHaveLength(2)
  })

  it('lets different props fire close together', () => {
    const hits = findTriggerHits(
      transcript([['fire', 0], ['brain', 500]]),
      [fire, brain],
      options
    )
    expect(hits.map((h) => h.assetId)).toEqual(['fire', 'brain'])
  })

  it('caps the overall rate, scaled to the media length', () => {
    // Ten distinct fireable words spread over one minute, cap of 2 per minute.
    const spec: [string, number][] = Array.from({ length: 10 }, (_, i) => [
      i % 2 === 0 ? 'fire' : 'brain',
      i * 6000
    ])
    const hits = findTriggerHits(transcript(spec), [fire, brain], {
      ...options,
      perMinute: 2,
      cooldownMs: 0
    })
    expect(hits.length).toBeLessThanOrEqual(2)
  })

  it('returns nothing for a transcript with no matches', () => {
    expect(findTriggerHits(transcript([['hello', 0], ['there', 400]]), [fire], options)).toEqual([])
  })

  it('returns nothing when there are no triggers or no words', () => {
    expect(findTriggerHits(transcript([['fire', 0]]), [], options)).toEqual([])
    expect(findTriggerHits(transcript([]), [fire], options)).toEqual([])
  })
})

describe('tagsForProp', () => {
  it('expands a prop name into its synonyms', () => {
    expect(tagsForProp('fire')).toContain('flame')
    expect(tagsForProp('rocket')).toContain('launch')
    expect(tagsForProp('coin')).toContain('revenue')
  })

  it('matches a partial name, since catalog names carry extra words', () => {
    expect(tagsForProp('holographic badge')).toContain('award')
  })

  it('falls back to the name itself for an unknown prop', () => {
    expect(tagsForProp('unicorn')).toEqual(['unicorn'])
  })
})
