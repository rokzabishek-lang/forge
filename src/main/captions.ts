import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Project } from '@shared/timeline'
import { buildTimelineCaptions } from '@shared/captions/timeline'
import { resolveStyle, type StyleOverrides } from '@shared/captions/style'

export interface PreparedCaptions {
  subtitlesPath: string
  fontsDir: string | undefined
  /** Remove the temp file once the render finishes, succeeds or not. */
  cleanup: () => Promise<void>
}

/**
 * Where libass looks for the fonts a style names.
 *
 * Asset placement is still undecided, so this resolves by preference and returns
 * undefined rather than failing — libass falls back to a system font, which is
 * worse-looking but never a broken render.
 */
function fontsDir(): string | undefined {
  const override = process.env.FORGE_FONTS_DIR
  if (override) return override
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'assets', 'fonts')
    : join(app.getAppPath(), 'assets', 'fonts')
  return bundled
}

/**
 * Write the timeline's captions to a temporary .ass file for the render.
 * Returns null when there is nothing to burn, which leaves the render plan
 * without a subtitles filter at all.
 */
export async function prepareCaptions(
  project: Project,
  canvas: { width: number; height: number }
): Promise<PreparedCaptions | null> {
  if (!project.captions?.enabled) return null

  const style = resolveStyle(
    project.captions.styleId,
    project.captions.overrides as StyleOverrides | undefined
  )
  const ass = buildTimelineCaptions(project, style, canvas)
  if (!ass) return null

  const dir = join(app.getPath('userData'), 'tmp')
  await mkdir(dir, { recursive: true })
  const subtitlesPath = join(dir, `captions-${randomUUID()}.ass`)
  await writeFile(subtitlesPath, ass, 'utf8')

  return {
    subtitlesPath,
    fontsDir: fontsDir(),
    cleanup: () => rm(subtitlesPath, { force: true }).catch(() => undefined)
  }
}
