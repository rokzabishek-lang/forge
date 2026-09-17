import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HOSTED,
  chooseProvider,
  clampSpeed,
  hostedReady,
  redactKey,
  speechKey,
  speechUrl,
  splitForSpeech,
  type ProviderStatus
} from '@shared/voice/provider'

const ready = (id: 'kokoro' | 'hosted'): ProviderStatus => ({
  id,
  label: id === 'kokoro' ? 'Kokoro' : 'Hosted API',
  kind: id === 'kokoro' ? 'local' : 'hosted',
  ready: true,
  reason: null
})

const missing = (id: 'kokoro' | 'hosted', reason: string): ProviderStatus => ({
  ...ready(id),
  ready: false,
  reason
})

describe('chooseProvider', () => {
  it('prefers the local one, which costs nothing per use', () => {
    const got = chooseProvider('auto', [ready('kokoro'), ready('hosted')])
    expect(got).toEqual({ id: 'kokoro' })
  })

  it('falls back to hosted when the local engine is not installed', () => {
    const got = chooseProvider('auto', [missing('kokoro', 'not installed'), ready('hosted')])
    expect(got).toEqual({ id: 'hosted' })
  })

  it('honours an explicit choice rather than substituting the other', () => {
    /*
     * The important one. Someone who picked a specific hosted voice and got the
     * local model instead has been handed a different performance without being
     * told — which is worse than an error, because it renders.
     */
    const got = chooseProvider('hosted', [ready('kokoro'), missing('hosted', 'no key yet')])
    expect(got).toEqual({ error: 'no key yet' })
  })

  it('uses hosted when hosted is what was asked for', () => {
    expect(chooseProvider('hosted', [ready('kokoro'), ready('hosted')])).toEqual({ id: 'hosted' })
  })

  it('reports BOTH reasons when neither works', () => {
    const got = chooseProvider('auto', [
      missing('kokoro', 'not installed'),
      missing('hosted', 'no key yet')
    ])
    expect('error' in got).toBe(true)
    const message = (got as { error: string }).error
    // Naming only the first sends someone off to install a model when they had
    // meant to use their own API and simply had not pasted the key in.
    expect(message).toContain('not installed')
    expect(message).toContain('no key yet')
  })

  it('says so when a provider does not exist at all', () => {
    expect(chooseProvider('kokoro', [ready('hosted')])).toEqual({
      error: 'There is no kokoro voice provider'
    })
  })
})

describe('hostedReady', () => {
  it('needs a URL and a key, and nothing else', () => {
    expect(hostedReady(DEFAULT_HOSTED)).toBe(false)
    expect(hostedReady({ ...DEFAULT_HOSTED, baseUrl: 'https://x/v1' })).toBe(false)
    expect(hostedReady({ ...DEFAULT_HOSTED, apiKey: 'k' })).toBe(false)
    expect(hostedReady({ ...DEFAULT_HOSTED, baseUrl: 'https://x/v1', apiKey: 'k' })).toBe(true)
  })

  it('is not fooled by whitespace', () => {
    expect(hostedReady({ ...DEFAULT_HOSTED, baseUrl: '   ', apiKey: '  ' })).toBe(false)
  })

  it('does not demand a model or a voice, which both have working defaults', () => {
    expect(
      hostedReady({ baseUrl: 'https://x/v1', apiKey: 'k', model: '', voice: '' })
    ).toBe(true)
  })
})

describe('speechUrl', () => {
  it('builds the path once, whatever the user pasted', () => {
    expect(speechUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/audio/speech')
    expect(speechUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/audio/speech')
    expect(speechUrl('https://api.example.com/v1///')).toBe(
      'https://api.example.com/v1/audio/speech'
    )
  })

  it('leaves a full endpoint alone rather than doubling it', () => {
    expect(speechUrl('https://api.example.com/v1/audio/speech')).toBe(
      'https://api.example.com/v1/audio/speech'
    )
  })

  it('works for a local server, which is the whole point of the shape', () => {
    // Kokoro-FastAPI serves the same model over this path.
    expect(speechUrl('http://localhost:8880/v1')).toBe('http://localhost:8880/v1/audio/speech')
  })
})

describe('clampSpeed', () => {
  it('defaults to natural pace for anything that is not a number', () => {
    expect(clampSpeed(undefined)).toBe(1)
    expect(clampSpeed(NaN)).toBe(1)
  })

  it('holds inside what an engine will accept', () => {
    expect(clampSpeed(0.1)).toBe(0.5)
    expect(clampSpeed(9)).toBe(2)
    expect(clampSpeed(1.25)).toBe(1.25)
  })
})

describe('speechKey', () => {
  it('is the same for the same speech', () => {
    expect(speechKey('kokoro', 'af', 1, 'Hello there')).toBe(
      speechKey('kokoro', 'af', 1, '  Hello there  ')
    )
  })

  it('changes with anything that changes the audio', () => {
    const base = speechKey('kokoro', 'af', 1, 'Hello')
    expect(speechKey('kokoro', 'am', 1, 'Hello')).not.toBe(base)
    expect(speechKey('kokoro', 'af', 1.5, 'Hello')).not.toBe(base)
    expect(speechKey('hosted', 'af', 1, 'Hello')).not.toBe(base)
    expect(speechKey('kokoro', 'af', 1, 'Goodbye')).not.toBe(base)
  })

  it('keeps its fields apart even when the text contains the separator', () => {
    // Text is user input and can hold anything, including the NUL the key joins
    // on. Built from a char code rather than written literally: a raw control
    // byte in a source file is invisible to review and survives no reformat.
    const nul = String.fromCharCode(0)
    expect(speechKey('kokoro', 'a', 1, `b${nul}c`)).not.toBe(speechKey('kokoro', 'a', 1, 'b'))
    expect(speechKey('kokoro', `a${nul}x`, 1, 'b')).not.toBe(
      speechKey('kokoro', 'a', 1, `x${nul}b`)
    )
  })
})

describe('splitForSpeech', () => {
  it('leaves something short alone', () => {
    expect(splitForSpeech('Hello there.')).toEqual(['Hello there.'])
  })

  it('returns nothing for nothing', () => {
    expect(splitForSpeech('   ')).toEqual([])
  })

  it('breaks on sentences, which is where a voice would breathe anyway', () => {
    const text = `${'A'.repeat(200)}. ${'B'.repeat(200)}. ${'C'.repeat(200)}.`
    const parts = splitForSpeech(text, 400)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(400)
    // Punctuation survives: it is what the engine reads intonation from.
    expect(parts.join(' ')).toContain('.')
  })

  it('fills each piece rather than emitting one sentence at a time', () => {
    const text = 'One. Two. Three. Four. Five.'
    expect(splitForSpeech(text, 400)).toEqual(['One. Two. Three. Four. Five.'])
    expect(splitForSpeech(text, 12).length).toBeGreaterThan(1)
  })

  it('breaks a sentence that is longer than the limit on its own', () => {
    const runOn = `${'word '.repeat(200)}`.trim()
    const parts = splitForSpeech(runOn, 300)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(300)
    // Nothing is lost on the way.
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(runOn)
  })

  it('prefers a comma to a bare space when it has to break mid-sentence', () => {
    const clause = `${'a'.repeat(120)}, ${'b'.repeat(120)}, ${'c'.repeat(120)}`
    const parts = splitForSpeech(clause, 200)
    expect(parts[0].endsWith(',')).toBe(true)
  })

  it('collapses the whitespace a text box leaves behind', () => {
    expect(splitForSpeech('Hello\n\n  there.')).toEqual(['Hello there.'])
  })
})

describe('redactKey', () => {
  const key = 'sk-live-0123456789abcdef'

  it('takes the key out of anything an endpoint echoes back', () => {
    const body = `{"error":"bad model","request":{"authorization":"Bearer ${key}"}}`
    const safe = redactKey(body, key)
    expect(safe).not.toContain(key)
    expect(safe).toContain('***')
    // And keeps the part worth reading: "bad model" is why the call failed.
    expect(safe).toContain('bad model')
  })

  it('takes out every occurrence, not just the first', () => {
    expect(redactKey(`${key} and again ${key}`, key)).not.toContain(key)
  })

  it('does not shred a message when there is no key to remove', () => {
    expect(redactKey('Quota exceeded', '')).toBe('Quota exceeded')
    // A short placeholder would otherwise split unrelated text apart.
    expect(redactKey('a test of the system', 'test')).toBe('a test of the system')
  })

  it('caps the length, because a 4xx body can be a whole HTML page', () => {
    const long = 'x'.repeat(5000)
    expect(redactKey(long, key).length).toBeLessThan(420)
  })
})
