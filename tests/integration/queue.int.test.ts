import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { JobQueue } from '../../src/main/queue'
import { startRender } from '../../src/main/render/renderJob'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { Job } from '@shared/types'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

let dir = ''
let source = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-queue-'))
  source = join(dir, 'src.mp4')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function project(durationFrames: number): Project {
  const asset: MediaAsset = {
    id: 'a1', path: source, name: 'src.mp4', kind: 'video',
    durationFrames: 600, width: 1280, height: 720, fps: 30,
    hasVideo: true, hasAudio: true, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: durationFrames, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  return { ...emptyProject(), assets: [asset], clips: [clip] }
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Resolve once the named job reaches a terminal state. */
function waitForStatus(queue: JobQueue, id: string, statuses: Job['status'][]): Promise<Job> {
  return new Promise((resolve) => {
    const check = (jobs: Job[]): void => {
      const job = jobs.find((j) => j.id === id)
      if (job && statuses.includes(job.status)) {
        queue.off('changed', check)
        resolve(job)
      }
    }
    queue.on('changed', check)
    check(queue.list())
  })
}

describe('render through the job queue', () => {
  it('reports advancing progress and completes', async () => {
    const out = join(dir, 'done.mp4')
    const seen: number[] = []

    const queue = new JobQueue((job, onProgress) =>
      startRender(
        { project: project(120), outputPath: job.output, crf: 28, preset: 'veryfast' },
        (progress, speed) => {
          seen.push(progress)
          onProgress(progress, speed)
        }
      )
    , 1)

    const job = queue.add({
      presetId: 'render', input: source, inputName: 'src.mp4', output: out, params: {}
    })

    const finished = await waitForStatus(queue, job.id, ['done', 'failed'])

    expect(finished.status).toBe('done')
    expect(finished.error).toBeNull()
    expect(finished.progress).toBe(1)
    expect(await exists(out)).toBe(true)

    // Progress must actually move, and never go backwards.
    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBe(1)
    const sorted = [...seen].sort((a, b) => a - b)
    expect(seen).toEqual(sorted)
  }, 180_000)

  it('cancels mid-render and removes the half-written file', async () => {
    const out = join(dir, 'cancelled.mp4')

    const queue = new JobQueue((job, onProgress) =>
      startRender(
        // Long + slow preset so there is real work to interrupt.
        { project: project(600), outputPath: job.output, crf: 18, preset: 'veryslow' },
        onProgress
      )
    , 1)

    const job = queue.add({
      presetId: 'render', input: source, inputName: 'src.mp4', output: out, params: {}
    })

    // Wait until ffmpeg is genuinely running before cancelling.
    await waitForStatus(queue, job.id, ['running'])
    await new Promise((r) => setTimeout(r, 700))
    queue.cancel(job.id)

    const finished = await waitForStatus(queue, job.id, ['cancelled', 'done', 'failed'])

    expect(finished.status).toBe('cancelled')
    expect(finished.error).toBeNull()
    // A truncated render must never be left behind looking like a success.
    expect(await exists(out)).toBe(false)
  }, 180_000)

  it('runs queued jobs to completion at concurrency 1', async () => {
    const outs = [join(dir, 'q1.mp4'), join(dir, 'q2.mp4')]

    const queue = new JobQueue((job, onProgress) =>
      startRender(
        { project: project(60), outputPath: job.output, crf: 30, preset: 'ultrafast' },
        onProgress
      )
    , 1)

    const jobs = outs.map((out) =>
      queue.add({ presetId: 'render', input: source, inputName: 'src.mp4', output: out, params: {} })
    )

    const results = await Promise.all(jobs.map((j) => waitForStatus(queue, j.id, ['done', 'failed'])))

    expect(results.map((r) => r.status)).toEqual(['done', 'done'])
    expect(await exists(outs[0])).toBe(true)
    expect(await exists(outs[1])).toBe(true)
  }, 180_000)
})
