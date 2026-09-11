import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/types'
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
    lastPresetId: null
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
    lastPresetId: typeof input.lastPresetId === 'string' ? input.lastPresetId : base.lastPresetId
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
