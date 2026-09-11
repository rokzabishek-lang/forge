import { access } from 'node:fs/promises'
import { dirname, join, basename, extname } from 'node:path'
import type { ParamValues, Preset } from '@shared/types'
import { extOf } from '@shared/media'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Work out where a job's result should be written.
 *
 * Guarantees the output never collides with the input — overwriting the source
 * mid-encode corrupts both. When overwrite is off, an existing file gets a
 * " (2)", " (3)" suffix rather than being replaced.
 */
export async function resolveOutputPath(opts: {
  input: string
  preset: Preset
  params: ParamValues
  outputDir: string | null
  overwrite: boolean
}): Promise<string> {
  const { input, preset, params, outputDir, overwrite } = opts

  const requestedExt = preset.outExt(params)
  const ext = requestedExt === 'keep' ? extOf(input) || 'out' : requestedExt

  const dir = outputDir ?? dirname(input)
  const stem = basename(input, extname(input))
  const base = `${stem}${preset.suffix}`

  let candidate = join(dir, `${base}.${ext}`)

  // Never write over the file being read.
  const collidesWithInput = (p: string): boolean => p === input

  if (!collidesWithInput(candidate) && overwrite) return candidate

  let counter = 2
  while ((await exists(candidate)) || collidesWithInput(candidate)) {
    candidate = join(dir, `${base} (${counter}).${ext}`)
    counter++
    if (counter > 999) throw new Error('Could not find a free filename for the output')
  }
  return candidate
}
