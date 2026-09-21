import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/types'
import { DEFAULT_DIRECTOR } from '@shared/director/provider'
import { defaultConcurrency } from './queue'

/**
 * A tiny JSON settings file. electron-store would do this too, but it is
 * ESM-only now and fights the CJS main bundle for no gain at this size.
 */
let cache: Settings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  return {
    outputDir: null,
    concurrency: defaultConcurrency(),
    overwrite: false,
    lastPresetId: null,
    voiceProvider: 'auto',
    voiceHosted: { baseUrl: '', model: 'tts-1', voice: 'alloy', apiKey: '' },
    director: {
      provider: DEFAULT_DIRECTOR.provider,
      ollama: { ...DEFAULT_DIRECTOR.ollama },
      gemini: { ...DEFAULT_DIRECTOR.gemini }
    }
  }
}

function sanitize(raw: unknown): Settings {
  const base = defaults()
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw as Record<string, unknown>
  return {
    outputDir: typeof input.outputDir === 'string' ? input.outputDir : base.outputDir,
    concurrency:
      typeof input.concurrency === 'number' && input.concurrency >= 1 && input.concurrency <= 8
        ? Math.floor(input.concurrency)
        : base.concurrency,
    overwrite: typeof input.overwrite === 'boolean' ? input.overwrite : base.overwrite,
    lastPresetId: typeof input.lastPresetId === 'string' ? input.lastPresetId : base.lastPresetId,
    voiceProvider:
      input.voiceProvider === 'kokoro' || input.voiceProvider === 'hosted'
        ? input.voiceProvider
        : 'auto',
    voiceHosted: voiceHosted(input.voiceHosted, base.voiceHosted!),
    director: director(input.director, base.director!)
  }
}

/**
 * Same discipline as the voice config: strings only, an enum for the choice,
 * and never a partial object. A settings file written before the director
 * existed has no `director` key at all and must load as the defaults.
 */
function director(raw: unknown, base: NonNullable<Settings['director']>): NonNullable<Settings['director']> {
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw as Record<string, unknown>
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback
  const ollama = typeof input.ollama === 'object' && input.ollama !== null ? (input.ollama as Record<string, unknown>) : {}
  const gemini = typeof input.gemini === 'object' && input.gemini !== null ? (input.gemini as Record<string, unknown>) : {}
  return {
    provider:
      input.provider === 'ollama' || input.provider === 'gemini' || input.provider === 'auto'
        ? input.provider
        : base.provider,
    ollama: {
      baseUrl: str(ollama.baseUrl, base.ollama.baseUrl),
      model: str(ollama.model, base.ollama.model)
    },
    gemini: {
      apiKey: str(gemini.apiKey, base.gemini.apiKey),
      model: str(gemini.model, base.gemini.model)
    }
  }
}

/** Strings only, and never a partial object — every field has a usable default. */
function voiceHosted(
  raw: unknown,
  base: NonNullable<Settings['voiceHosted']>
): NonNullable<Settings['voiceHosted']> {
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw as Record<string, unknown>
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback
  return {
    baseUrl: str(input.baseUrl, base.baseUrl),
    model: str(input.model, base.model),
    voice: str(input.voice, base.voice),
    apiKey: str(input.apiKey, base.apiKey)
  }
}

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = sanitize(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    cache = defaults()
  }
  return cache
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = sanitize({ ...getSettings(), ...patch })
  cache = next
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // A read-only home directory should not take the app down; the in-memory
    // value still applies for this session.
  }
  return next
}
