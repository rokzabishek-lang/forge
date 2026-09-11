export type MediaKind = 'video' | 'audio' | 'image'

export interface MediaInfo {
  path: string
  name: string
  size: number
  kind: MediaKind
  durationMs: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
  fps: number | null
}

export type ParamValue = string | number | boolean
export type ParamValues = Record<string, ParamValue>

export type ParamSpec =
  | {
      key: string
      label: string
      type: 'select'
      options: { value: string; label: string }[]
      default: string
      help?: string
    }
  | {
      key: string
      label: string
      type: 'range'
      min: number
      max: number
      step: number
      default: number
      help?: string
      /** Optional labels for the low and high ends of the slider. */
      ends?: [string, string]
    }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; default: number; help?: string }
  | { key: string; label: string; type: 'text'; default: string; placeholder?: string; help?: string }
  | { key: string; label: string; type: 'toggle'; default: boolean; help?: string }

export interface BuildContext {
  input: string
  output: string
  params: ParamValues
  info: MediaInfo
}

export interface Preset {
  id: string
  label: string
  description: string
  kind: MediaKind
  engine: 'ffmpeg' | 'sharp'
  /** Lowercase extensions without the dot. */
  accepts: string[]
  /** Filename suffix added before the extension, e.g. "-compressed". */
  suffix: string
  outExt: (params: ParamValues) => string
  params: ParamSpec[]
  /** Pure: preset + params -> ffmpeg argv (ffmpeg engine only). */
  buildArgs?: (ctx: BuildContext) => string[]
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  presetId: string
  input: string
  inputName: string
  output: string
  params: ParamValues
  status: JobStatus
  /** 0..1, or null when the job has no measurable duration. */
  progress: number
  speed: string | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}

export interface Settings {
  outputDir: string | null
  concurrency: number
  overwrite: boolean
  lastPresetId: string | null
}

export interface JobRequest {
  presetId: string
  input: string
  params: ParamValues
}

/** Renderer -> main, invoke channels. */
export interface ForgeApi {
  getPathForFile: (file: File) => string
  probe: (paths: string[]) => Promise<{ ok: MediaInfo[]; failed: { path: string; error: string }[] }>
  enqueue: (requests: JobRequest[]) => Promise<Job[]>
  cancelJob: (id: string) => Promise<void>
  cancelAll: () => Promise<void>
  clearFinished: () => Promise<void>
  getSettings: () => Promise<Settings>
  setSettings: (patch: Partial<Settings>) => Promise<Settings>
  chooseOutputDir: () => Promise<string | null>
  openPath: (path: string) => Promise<void>
  revealPath: (path: string) => Promise<void>
  pickFiles: () => Promise<string[]>
  onJobsChanged: (cb: (jobs: Job[]) => void) => () => void
}
