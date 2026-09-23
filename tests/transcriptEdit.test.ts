import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VOCABULARY_MAX_CHARS, segmentIntoSentences, vocabularyPrompt, withWordText, type Transcript, type Word } from '@shared/transcript'
import { buildTimelineCaptions } from '@shared/captions/timeline'
import { CAPTION_STYLES } from '@shared/captions/style'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Transcript editing and vocabulary (FIX.md B3).
 */

const words: Word[] = ['Welcome', 'to', 'Pria', 'and', 'Arjun’s', 'wedding', 'thank', 'you', 'for', 'coming.'].map(
  (text, index) => ({ index, text, startMs: index * 400, endMs: index * 400 + 350, confidence: 0.9 })
)
const transcript: Transcript = { assetId: 'v', language: 'en', model: 'm', durationMs: 4000, words, segments: segmentIntoSentences(words) }

describe('correcting a word', () => {
  it('changes the text and keeps the timing; its confidence is no longer the model’s', () => {
    const fixed = withWordText(transcript, 2, 'Priya')
    expect(fixed.words[2]).toEqual({ index: 2, text: 'Priya', startMs: 800, endMs: 1150, confidence: null })
    expect(fixed.segments[0].text).toContain('Welcome to Priya and')
    // The original is untouched.
    expect(transcript.words[2].text).toBe('Pria')
  })

  it('a word left as it was, or one that is not there, is no edit at all', () => {
    expect(withWordText(transcript, 2, ' Pria ')).toBe(transcript)
    expect(withWordText(transcript, 99, 'x')).toBe(transcript)
  })

  it('an empty word is taken out, and the others keep their indices', () => {
    const cut = withWordText(transcript, 1, '   ')
    expect(cut.words.map((w) => w.index)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(cut.segments[0].text.startsWith('Welcome Pria')).toBe(true)
  })

  it('a full stop added ends a sentence there — the segments follow the words', () => {
    expect(transcript.segments).toHaveLength(1)
    const split = withWordText(transcript, 5, 'wedding.')
    expect(split.segments.map((s) => s.text)).toEqual(['Welcome to Pria and Arjun’s wedding.', 'thank you for coming.'])
    // With the same boundaries, the ids come out the same.
    expect(withWordText(transcript, 2, 'Priya').segments.map((s) => s.id)).toEqual(transcript.segments.map((s) => s.id))
  })

  it('collapses the spaces a paste brings', () => {
    expect(withWordText(transcript, 4, '  Arjun’s \n').words[4].text).toBe('Arjun’s')
    expect(withWordText(transcript, 2, 'Priya   Sharma').words[2].text).toBe('Priya Sharma')
  })
})

describe('the captions follow the correction', () => {
  it('into the export’s subtitle file', () => {
    const asset: MediaAsset = { id: 'v', path: '/v.mp4', name: 'v', kind: 'video', durationFrames: 300, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, size: 1 }
    const clip: Clip = {
      id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 150, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 }
    }
    const project = (t: Transcript): Project => ({ ...emptyProject(), assets: [asset], clips: [clip], transcripts: { v: t } })
    const before = buildTimelineCaptions(project(transcript), CAPTION_STYLES[0], { width: 1080, height: 1920 })!
    const after = buildTimelineCaptions(project(withWordText(transcript, 2, 'Priya')), CAPTION_STYLES[0], { width: 1080, height: 1920 })!
    expect(before).toMatch(/Pria\b/i)
    expect(after).toMatch(/Priya/i)
    expect(after).not.toMatch(/Pria\b/i)
  })
})

describe('the vocabulary', () => {
  it('becomes one prompt of the names, whatever separates them', () => {
    expect(vocabularyPrompt('Priya, Arjun,\nTaj  Falaknuma')).toBe('Priya, Arjun, Taj Falaknuma.')
    // One name per line, no commas at all — how a list is usually pasted.
    expect(vocabularyPrompt('Priya\nArjun\nTaj Falaknuma')).toBe('Priya, Arjun, Taj Falaknuma.')
    expect(vocabularyPrompt(' , \n ')).toBeUndefined()
    expect(vocabularyPrompt(undefined)).toBeUndefined()
    expect(vocabularyPrompt('x'.repeat(5000))!.length).toBe(VOCABULARY_MAX_CHARS)
  })
})

describe('the vocabulary reaches the model', () => {
  const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

  it('the store sends it with every transcription of a clip', () => {
    expect(source('src/renderer/src/store.ts')).toContain('initialPrompt: vocabularyPrompt(project.vocabulary)')
  })

  it('the main process bounds it and hands it to the sidecar', () => {
    const ipc = source('src/main/ipc.ts')
    expect(ipc).toContain('initialPrompt.slice(0, VOCABULARY_MAX_CHARS)')
  })

  it('the sidecar gives it to faster-whisper as initial_prompt', () => {
    const asr = source('sidecar/forge_sidecar/capabilities/asr.py')
    expect(asr).toContain('prompt = params.get("initialPrompt")')
    expect(asr).toContain('initial_prompt=initial_prompt,')
  })
})
