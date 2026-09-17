import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'
import type { Job, JobStatus } from '@shared/types'

export interface ExecutionHandle {
  promise: Promise<void>
  cancel: () => void
}

/**
 * How a job actually gets done. ffmpeg and sharp both plug in here, so the queue
 * never learns what kind of work it is running.
 */
export type Executor = (
  job: Job,
  onProgress: (progress: number, speed: string | null) => void
) => ExecutionHandle

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(cpus().length / 2) || 1))
}

export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>()
  private order: string[] = []
  private running = new Map<string, ExecutionHandle>()
  private concurrency: number

  constructor(
    private execute: Executor,
    concurrency = defaultConcurrency()
  ) {
    super()
    this.concurrency = concurrency
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(8, Math.floor(n) || 1))
    this.pump()
  }

  list(): Job[] {
    return this.order.map((id) => this.jobs.get(id)!).filter(Boolean)
  }

  /**
   * Queue a job.
   *
   * `register` runs with the new job's id BEFORE the executor can start, and
   * that ordering is the whole point of it existing. The queue pumps
   * synchronously, so a caller that does `const job = add(...)` and only then
   * records anything under `job.id` is already too late — the executor has run
   * and failed looking for it. That is exactly how every export came to fail
   * with "This export is missing its render settings".
   */
  add(
    job: Omit<Job, 'id' | 'status' | 'progress' | 'speed' | 'error' | 'startedAt' | 'finishedAt'>,
    register?: (id: string) => void
  ): Job {
    const full: Job = {
      ...job,
      id: randomUUID(),
      status: 'queued',
      progress: 0,
      speed: null,
      error: null,
      startedAt: null,
      finishedAt: null
    }
    this.jobs.set(full.id, full)
    this.order.push(full.id)
    register?.(full.id)
    this.changed()
    this.pump()
    return full
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return

    const handle = this.running.get(id)
    if (handle) {
      // The executor's rejection path marks the job cancelled and cleans up.
      handle.cancel()
      return
    }
    if (job.status === 'queued') {
      this.patch(id, { status: 'cancelled', finishedAt: Date.now() })
      this.pump()
    }
  }

  cancelAll(): void {
    for (const id of [...this.order]) this.cancel(id)
  }

  clearFinished(): void {
    const finished: JobStatus[] = ['done', 'failed', 'cancelled']
    for (const id of [...this.order]) {
      const job = this.jobs.get(id)
      if (job && finished.includes(job.status)) {
        this.jobs.delete(id)
        this.order = this.order.filter((o) => o !== id)
      }
    }
    this.changed()
  }

  private patch(id: string, patch: Partial<Job>): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.set(id, { ...job, ...patch })
    this.changed()
  }

  private changed(): void {
    this.emit('changed', this.list())
  }

  private pump(): void {
    if (this.running.size >= this.concurrency) return

    for (const id of this.order) {
      if (this.running.size >= this.concurrency) return
      const job = this.jobs.get(id)
      if (!job || job.status !== 'queued') continue
      this.start(job)
    }
  }

  private start(job: Job): void {
    this.patch(job.id, { status: 'running', startedAt: Date.now(), progress: 0 })

    let lastEmit = 0
    const onProgress = (progress: number, speed: string | null): void => {
      // ffmpeg emits progress several times a second; throttle so the renderer
      // is not flooded with IPC messages on a long encode.
      const now = Date.now()
      if (progress < 1 && now - lastEmit < 150) return
      lastEmit = now
      this.patch(job.id, { progress, speed })
    }

    let handle: ExecutionHandle
    try {
      handle = this.execute(this.jobs.get(job.id)!, onProgress)
    } catch (err) {
      this.patch(job.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now()
      })
      this.pump()
      return
    }

    this.running.set(job.id, handle)

    handle.promise
      .then(() => {
        this.patch(job.id, { status: 'done', progress: 1, finishedAt: Date.now(), speed: null })
      })
      .catch((err: unknown) => {
        const cancelled = err instanceof Error && err.name === 'CancelledError'
        this.patch(job.id, {
          status: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? null : err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
          speed: null
        })
      })
      .finally(() => {
        this.running.delete(job.id)
        this.pump()
      })
  }
}
