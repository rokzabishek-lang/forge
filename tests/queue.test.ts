import { describe, it, expect } from 'vitest'
import { JobQueue } from '../src/main/queue'
import type { Job } from '@shared/types'

const spec = {
  presetId: 'render',
  input: 'project',
  inputName: 'out.mp4',
  output: '/tmp/out.mp4',
  params: {}
}

function settled(queue: JobQueue): Promise<Job[]> {
  return new Promise((resolve) => {
    queue.on('changed', (jobs: Job[]) => {
      if (jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')) {
        resolve(jobs)
      }
    })
  })
}

describe('JobQueue', () => {
  /*
   * The bug this exists to prevent.
   *
   * `render:start` does `const job = queue.add(...)` and only then records the
   * render settings under `job.id`. If add() runs the executor synchronously,
   * the executor looks for settings that have not been stored yet and every
   * export fails with "This export is missing its render settings" — which,
   * with the progress panel off-screen, presented as exports silently doing
   * nothing at all.
   */
  it('does not run a job before the caller can register its settings', async () => {
    const settings = new Map<string, string>()
    const queue = new JobQueue((job) => {
      const found = settings.get(job.id)
      if (!found) throw new Error('This export is missing its render settings')
      return { promise: Promise.resolve(), cancel: () => undefined }
    }, 1)

    const done = settled(queue)
    const job = queue.add(spec, (id) => settings.set(id, 'ready'))

    const jobs = await done
    expect(jobs.find((j) => j.id === job.id)?.status).toBe('done')
  })

  it('runs the job when there is no registration step', async () => {
    const queue = new JobQueue(() => ({ promise: Promise.resolve(), cancel: () => undefined }), 1)
    const done = settled(queue)
    queue.add(spec)
    expect((await done)[0].status).toBe('done')
  })

  it('marks a job failed when its executor throws', async () => {
    const queue = new JobQueue(() => {
      throw new Error('no settings')
    }, 1)
    const done = settled(queue)
    queue.add(spec)
    const [job] = await done
    expect(job.status).toBe('failed')
    expect(job.error).toBe('no settings')
  })

  it('reports the job through the changed event as soon as it is queued', async () => {
    // The renderer only learns about jobs through this event, so a job that is
    // never announced is a job the user cannot see.
    const seen: Job[][] = []
    const queue = new JobQueue(
      () => ({ promise: new Promise<void>(() => undefined), cancel: () => undefined }),
      1
    )
    queue.on('changed', (jobs: Job[]) => seen.push(jobs))
    queue.add(spec)

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0][0].status).toBe('queued')
    expect(seen.at(-1)?.[0].status).toBe('running')
  })

  it('surfaces progress as it arrives', async () => {
    let report: ((p: number, s: string | null) => void) | null = null
    const queue = new JobQueue((_job, onProgress) => {
      report = onProgress
      return { promise: new Promise<void>(() => undefined), cancel: () => undefined }
    }, 1)
    const job = queue.add(spec)

    report!(0.5, '2.1x')
    const running = queue.list().find((j) => j.id === job.id)
    expect(running?.progress).toBe(0.5)
    expect(running?.speed).toBe('2.1x')
  })
})
