import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  LineDecoder,
  METHOD_CANCEL,
  RPC_ERRORS,
  SIDECAR_METHODS,
  encode,
  isFailure,
  isNotification,
  isResponse,
  type HelloResult,
  type ProgressParams,
  type RpcMessage
} from '@shared/sidecar/protocol'

export interface SidecarOptions {
  /** Directory containing the forge_sidecar package. */
  cwd: string
  /** Python interpreter. Defaults to the FORGE_PYTHON env var, then python3. */
  python?: string
  /** How many times to restart after an unexpected exit before giving up. */
  maxRestarts?: number
  /** Where models are downloaded and cached. Should be under userData. */
  modelsDir?: string
}

export interface RequestOptions {
  onProgress?: (progress: number | null, message?: string) => void
  /** Aborting sends a cancel notification; the handler stops cooperatively. */
  signal?: AbortSignal
  timeoutMs?: number
}

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'SidecarError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: (progress: number | null, message?: string) => void
  timer?: NodeJS.Timeout
}

/**
 * Supervises the Python sidecar and speaks JSON-RPC to it over stdio.
 *
 * The process is treated as disposable: it can crash, be killed, or be restarted
 * and the app keeps working with those capabilities unavailable. Nothing in the
 * editor may depend on it being alive.
 */
export class SidecarClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private decoder = new LineDecoder()
  private pending = new Map<number, Pending>()
  private nextId = 1
  private restarts = 0
  private stopping = false
  private hello: HelloResult | null = null

  constructor(private options: SidecarOptions) {
    super()
  }

  get running(): boolean {
    return this.child !== null && !this.child.killed
  }

  get info(): HelloResult | null {
    return this.hello
  }

  async start(): Promise<HelloResult> {
    if (this.running && this.hello) return this.hello
    this.spawnChild()
    this.hello = await this.request<HelloResult>(SIDECAR_METHODS.hello, {}, { timeoutMs: 30_000 })
    this.emit('ready', this.hello)
    return this.hello
  }

  private spawnChild(): void {
    const python = this.options.python ?? process.env.FORGE_PYTHON ?? 'python3'

    const child = spawn(python, ['-m', 'forge_sidecar'], {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // Unbuffered, or responses sit in Python's stdout buffer until it fills.
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(this.options.modelsDir ? { FORGE_MODELS_DIR: this.options.modelsDir } : {}),
        // Hugging Face's Xet backend talks to a separate CDN host that
        // restricted networks and corporate proxies routinely block. The plain
        // HTTP path is slower but works everywhere.
        HF_HUB_DISABLE_XET: '1',
        HF_HUB_DISABLE_TELEMETRY: '1'
      }
    }) as ChildProcessWithoutNullStreams

    this.child = child
    this.decoder.reset()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const message of this.decoder.push(chunk)) this.dispatch(message)
    })

    // stderr is the sidecar's log channel: stdout is reserved for protocol.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trimEnd()
      if (text) this.emit('log', text)
    })

    child.on('error', (err) => {
      this.failAll(new SidecarError(`Could not start the sidecar: ${err.message}`, RPC_ERRORS.internalError))
    })

    child.on('exit', (code, signal) => {
      this.child = null
      this.hello = null
      const reason = signal ? `signal ${signal}` : `code ${code}`
      this.failAll(new SidecarError(`The sidecar stopped (${reason})`, RPC_ERRORS.internalError))
      this.emit('exit', { code, signal })

      if (this.stopping) return
      const limit = this.options.maxRestarts ?? 3
      if (this.restarts < limit) {
        this.restarts++
        // Back off so a sidecar that crashes on startup cannot spin.
        const delay = Math.min(8000, 400 * 2 ** (this.restarts - 1))
        setTimeout(() => {
          if (!this.stopping) void this.start().catch(() => undefined)
        }, delay)
      } else {
        this.emit('gaveUp')
      }
    })
  }

  private dispatch(message: RpcMessage): void {
    if (isNotification(message)) {
      if (message.method === 'progress') {
        const params = message.params as ProgressParams
        this.pending.get(params.id)?.onProgress?.(params.progress, params.message)
      }
      return
    }
    if (!isResponse(message)) return

    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (entry.timer) clearTimeout(entry.timer)

    if (isFailure(message)) {
      entry.reject(new SidecarError(message.error.message, message.error.code, message.error.data))
    } else {
      entry.resolve(message.result)
    }
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  request<T>(method: string, params: unknown = {}, options: RequestOptions = {}): Promise<T> {
    if (!this.child) {
      // A request before start() (or after a crash) brings the process back.
      this.spawnChild()
    }
    const child = this.child
    if (!child) {
      return Promise.reject(new SidecarError('The sidecar is not running', RPC_ERRORS.internalError))
    }

    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress
      }

      if (options.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          this.cancel(id)
          reject(new SidecarError(`${method} timed out`, RPC_ERRORS.internalError))
        }, options.timeoutMs)
      }

      this.pending.set(id, entry)

      options.signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          if (entry.timer) clearTimeout(entry.timer)
          this.cancel(id)
          reject(new SidecarError('Cancelled', RPC_ERRORS.cancelled))
        },
        { once: true }
      )

      child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (!err) return
        this.pending.delete(id)
        reject(new SidecarError(`Could not send ${method}: ${err.message}`, RPC_ERRORS.internalError))
      })
    })
  }

  /** Fire-and-forget cancel; the handler stops at its next checkpoint. */
  private cancel(id: number): void {
    if (!this.child) return
    this.child.stdin.write(encode({ jsonrpc: '2.0', method: METHOD_CANCEL, params: { id } }))
  }

  stop(): void {
    this.stopping = true
    this.failAll(new SidecarError('The sidecar is shutting down', RPC_ERRORS.internalError))
    const child = this.child
    if (!child) return
    this.child = null
    // Closing stdin ends the read loop cleanly; kill only if it ignores that.
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
    child.once('exit', () => clearTimeout(timer))
  }
}
