import { describe, it, expect, beforeEach } from 'vitest'
import { segmentIntoSentences, type Word } from '@shared/transcript'
import { emptyProject } from '@shared/timeline'
import { useEditor } from '../../src/renderer/src/store'

const words: Word[] = ['one', 'two', 'three.'].map((text, index) => ({ index, text, startMs: index * 300, endMs: index * 300 + 250, confidence: 0.8 }))

beforeEach(() => {
  useEditor.setState({
    project: { ...emptyProject(), transcripts: { v: { assetId: 'v', language: 'en', model: 'm', durationMs: 900, words, segments: segmentIntoSentences(words) } } },
    past: [],
    future: []
  })
})

describe('transcript editing in the store', () => {
  it('one correction is one history entry, and undo brings the word back', () => {
    useEditor.getState().editTranscriptWord('v', 1, 'too')
    expect(useEditor.getState().project.transcripts.v.words[1].text).toBe('too')
    expect(useEditor.getState().past).toHaveLength(1)
    useEditor.getState().undo()
    expect(useEditor.getState().project.transcripts.v.words[1].text).toBe('two')
  })

  it('a word left as it was makes no history', () => {
    useEditor.getState().editTranscriptWord('v', 1, 'two')
    expect(useEditor.getState().past).toHaveLength(0)
  })

  it('the vocabulary is kept, and cleared means gone', () => {
    useEditor.getState().setVocabulary('Priya, Arjun')
    expect(useEditor.getState().project.vocabulary).toBe('Priya, Arjun')
    useEditor.getState().setVocabulary('   ')
    expect('vocabulary' in useEditor.getState().project).toBe(false)
  })
})
