import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { SidecarClient, SidecarError } from '../../src/main/sidecar/client'
import { SIDECAR_METHODS, RPC_ERRORS, type HelloResult } from '@shared/sidecar/protocol'

const SIDECAR_DIR = resolve(__dirname, '../../sidecar')

let client: SidecarClient | null = null

function makeClient(options: Partial<{ maxRestarts: number }> = {}): SidecarClient {
  client = new SidecarClient({ cwd: SIDECAR_DIR, maxRestarts: options.maxRestarts ?? 0 })
  return client
}

afterEach(() => {
  client?.stop()
  client = null
})

describe('sidecar handshake', () => {
  it('starts and reports its capabilities', async () => {
    const hello = await makeClient().start()
    expect(hello.protocolVersion).toBe(1)
    expect(hello.python).toMatch(/^3\./)
    expect(hello.capabilities).toContain(SIDECAR_METHODS.hello)
    expect(hello.capabilities).toContain(SIDECAR_METHODS.ping)
  }, 60_000)

  it('round-trips a ping', async () => {
    const c = makeClient()
    await c.start()
    const result = await c.request<{ pong: string }>(SIDECAR_METHODS.ping, { echo: 'forge' })
    expect(result.pong).toBe('forge')
  }, 60_000)

  it('reports a missing capability as degraded rather than crashing', async () => {
    const hello: HelloResult = await makeClient().start()
    // asr.transcribe is not installed in this environment; the sidecar must
    // still start and explain why the capability is absent.
    if (!hello.capabilities.includes(SIDECAR_METHODS.transcribe)) {
      expect(Object.keys(hello.degraded)).toContain(SIDECAR_METHODS.transcribe)
      expect(hello.degraded[SIDECAR_METHODS.transcribe]).toBeTruthy()
    }
  }, 60_000)
})

describe('errors', () => {
  it('returns method-not-found for an unknown method', async () => {
    const c = makeClient()
    await c.start()
    await expect(c.request('does.not.exist')).rejects.toMatchObject({
      code: RPC_ERRORS.methodNotFound
    })
  }, 60_000)

  it('rejects non-object params', async () => {
    const c = makeClient()
    await c.start()
    await expect(c.request(SIDECAR_METHODS.ping, 'not-an-object')).rejects.toMatchObject({
      code: RPC_ERRORS.invalidParams
    })
  }, 60_000)
})

describe('progress and cancellation', () => {
  it('streams progress while a request runs', async () => {
    const c = makeClient()
    await c.start()
    const seen: (number | null)[] = []

    await c.request('system.sleep', { seconds: 0.6 }, { onProgress: (p) => seen.push(p) })

    expect(seen.length).toBeGreaterThan(2)
    expect(seen.at(-1)).toBeCloseTo(1, 5)
    // Progress must be monotonic — a bar that goes backwards reads as a bug.
    const numeric = seen.filter((p): p is number => p !== null)
    expect(numeric).toEqual([...numeric].sort((a, b) => a - b))
  }, 60_000)

  it('cancels a running request via AbortSignal', async () => {
    const c = makeClient()
    await c.start()
    const controller = new AbortController()

    const promise = c.request('system.sleep', { seconds: 10 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 250)

    await expect(promise).rejects.toMatchObject({ code: RPC_ERRORS.cancelled })
  }, 60_000)

  it('stays usable after a cancellation', async () => {
    const c = makeClient()
    await c.start()
    const controller = new AbortController()
    const promise = c.request('system.sleep', { seconds: 10 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await expect(promise).rejects.toThrow()

    // The read loop must survive a cancelled request.
    const result = await c.request<{ pong: string }>(SIDECAR_METHODS.ping, { echo: 'still here' })
    expect(result.pong).toBe('still here')
  }, 60_000)

  it('times out and cancels the underlying work', async () => {
    const c = makeClient()
    await c.start()
    await expect(
      c.request('system.sleep', { seconds: 10 }, { timeoutMs: 300 })
    ).rejects.toThrow(/timed out/)

    const result = await c.request<{ pong: number }>(SIDECAR_METHODS.ping, { echo: 1 })
    expect(result.pong).toBe(1)
  }, 60_000)

  it('runs concurrent requests without interleaving their responses', async () => {
    const c = makeClient()
    await c.start()
    const results = await Promise.all([
      c.request<{ pong: string }>(SIDECAR_METHODS.ping, { echo: 'a' }),
      c.request<{ slept: number }>('system.sleep', { seconds: 0.3 }),
      c.request<{ pong: string }>(SIDECAR_METHODS.ping, { echo: 'c' })
    ])
    expect(results[0].pong).toBe('a')
    expect(results[1].slept).toBeCloseTo(0.3, 5)
    expect(results[2].pong).toBe('c')
  }, 60_000)
})

describe('lifecycle', () => {
  it('rejects in-flight requests when stopped', async () => {
    const c = makeClient()
    await c.start()
    const promise = c.request('system.sleep', { seconds: 10 })
    c.stop()
    await expect(promise).rejects.toBeInstanceOf(SidecarError)
  }, 60_000)

  it('restarts after an unexpected exit when configured to', async () => {
    const c = makeClient({ maxRestarts: 2 })
    await c.start()

    const exited = new Promise<void>((r) => c.once('exit', () => r()))
    // Ask the sidecar to take its own process down.
    void c.request('system.ping', { echo: 'x' }).catch(() => undefined)
    ;(c as unknown as { child: { kill: (s: string) => void } | null }).child?.kill('SIGKILL')
    await exited

    // A later request must bring it back rather than failing forever.
    const result = await c.request<{ pong: string }>(SIDECAR_METHODS.ping, { echo: 'back' })
    expect(result.pong).toBe('back')
  }, 60_000)
})
