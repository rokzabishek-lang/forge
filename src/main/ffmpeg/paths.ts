import { accessSync, constants } from 'node:fs'
import { sep } from 'node:path'
import { app } from 'electron'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'

/**
 * Binaries shipped inside node_modules end up inside app.asar once packaged, and
 * nothing inside an asar archive can be executed. electron-builder is configured
 * to unpack these two packages, so the real file sits in app.asar.unpacked.
 */
function resolveBinary(modulePath: string): string {
  if (!app.isPackaged) return modulePath
  // Anchored on the separator: a bare 'app.asar' replace would also rewrite a
  // directory that merely starts with that name.
  return modulePath.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

export const FFMPEG_PATH = resolveBinary(ffmpegInstaller.path)
export const FFPROBE_PATH = resolveBinary(ffprobeInstaller.path)

/**
 * Fail loudly at startup rather than on the first job. A missing or non-executable
 * binary is the single most common packaging bug in an app like this, and it never
 * reproduces in dev.
 */
export function assertBinaries(): { ok: true } | { ok: false; message: string } {
  for (const [name, path] of [
    ['ffmpeg', FFMPEG_PATH],
    ['ffprobe', FFPROBE_PATH]
  ] as const) {
    try {
      accessSync(path, constants.X_OK)
    } catch {
      return {
        ok: false,
        message: `${name} is missing or not executable at:\n${path}\n\nThe app cannot process media without it.`
      }
    }
  }
  return { ok: true }
}
