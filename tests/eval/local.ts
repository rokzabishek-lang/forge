import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import type { TransitionDef } from '@shared/transitions/registry'
import { transitionsFromMasks } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import type { Measure } from '@shared/director/gate'
import { SidecarClient } from '../../src/main/sidecar/client'
import { FFMPEG } from './media'
import type { AnalyseBeats } from './pipeline'

/**
 * What this machine has that CI does not: the asset library's wipes, and the
 * sidecar's Python. Each is used when it is there and its absence is reported
 * as a sentence, so a run's record says what it was measured with.
 */

export const REPO = resolve(__dirname, '..', '..')
const SIDECAR_DIR = join(REPO, 'sidecar')
const VENV_PYTHON = join(SIDECAR_DIR, '.venv', 'bin', 'python')
export const FFPROBE: string = ffprobeInstaller.path

/** The library's wipes, when the library is on this machine. */
export async function libraryTransitions(): Promise<{ transitions: TransitionDef[]; resolveAsset?: (rel: string) => string }> {
  const root = process.env.FORGE_ASSETS_DIR ?? join(REPO, 'assets')
  if (!existsSync(join(root, 'transitions'))) return { transitions: [] }
  process.env.FORGE_ASSETS_DIR = root
  const { scanAssets, resolveAssetFile } = await import('../../src/main/assets/scan')
  const { entriesOfKind } = await import('@shared/assets/catalog')
  const catalog = await scanAssets(root)
  const masks = entriesOfKind(catalog, 'transition').map((e) => ({ id: e.id, name: e.name, file: e.file }))
  return { transitions: transitionsFromMasks(masks), resolveAsset: resolveAssetFile }
}

export interface Sidecar {
  client: SidecarClient
  capabilities: string[]
  degraded: Record<string, string>
}

/** The sidecar, started — or the reason it could not be. `stop()` is safe either way. */
export async function startSidecar(): Promise<{ sidecar: Sidecar | null; note: string | null; stop: () => void }> {
  const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.FORGE_PYTHON
  if (!python) return { sidecar: null, note: 'no Python for the sidecar', stop: () => undefined }
  const client = new SidecarClient({ cwd: SIDECAR_DIR, python, maxRestarts: 0 })
  try {
    const hello = await client.start()
    return { sidecar: { client, capabilities: hello.capabilities, degraded: hello.degraded }, note: null, stop: () => client.stop() }
  } catch (err) {
    client.stop()
    return { sidecar: null, note: err instanceof Error ? err.message : String(err), stop: () => undefined }
  }
}

/** The client when the sidecar has a capability, else why it has not. */
export function capability(
  started: { sidecar: Sidecar | null; note: string | null },
  name: string
): { client: SidecarClient; note: null } | { client: null; note: string } {
  if (!started.sidecar) return { client: null, note: started.note ?? 'no sidecar' }
  const { client, capabilities, degraded } = started.sidecar
  if (!capabilities.includes(name) || degraded[name]) return { client: null, note: degraded[name] ?? `${name} is not available` }
  return { client, note: null }
}

/** Beats through the sidecar, as the app gets them. */
export const beatsVia =
  (client: SidecarClient): AnalyseBeats =>
  (path, window) =>
    client.request<MusicAnalysis>('audio.beats', { path, ffmpeg: FFMPEG, ...window }, { timeoutMs: 300_000 })

/** One photo's measurement as `vision.measure` returns it — with an error instead when the photo would not open. */
export type Measured = { path: string; error?: string } & Partial<Measure>

/**
 * A measurement the gate can use, or null when the sidecar reported an error
 * or a number is missing. Every field the gate reads is carried — a first
 * version listed them by hand and dropped `backdropClip`, so the white-backdrop
 * fix never reached the real run.
 */
export function measureOf(m: Measured): Measure | null {
  const { sharpness, luma, lumaStd, darkClip, brightClip, backdropClip, width, height } = m
  if (m.error) return null
  if ([sharpness, luma, lumaStd, darkClip, brightClip, width, height].some((v) => typeof v !== 'number')) return null
  return {
    sharpness: sharpness!, luma: luma!, lumaStd: lumaStd!, darkClip: darkClip!, brightClip: brightClip!,
    ...(typeof backdropClip === 'number' ? { backdropClip } : {}),
    dhash: m.dhash ?? null, width: width!, height: height!
  }
}

/** The photos measured through the sidecar, as the app's `measurePhotos` asks (main/ipc.ts). */
export const measureVia =
  (client: SidecarClient) =>
  (paths: string[]): Promise<{ measures: Measured[] }> =>
    client.request<{ measures: Measured[] }>('vision.measure', { paths, ffmpeg: FFMPEG, ffprobe: FFPROBE }, { timeoutMs: 120_000 })

/** Beats through the sidecar, or null when the sidecar cannot — the shape `director.eval.test.ts` has always used. */
export async function sidecarBeats(): Promise<{ analyse: AnalyseBeats | null; stop: () => void; note: string | null }> {
  const started = await startSidecar()
  const beats = capability(started, 'audio.beats')
  if (!beats.client) {
    started.stop()
    return { analyse: null, stop: () => undefined, note: beats.note }
  }
  return { analyse: beatsVia(beats.client), stop: started.stop, note: null }
}
