import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
 * The voice-over recorder, driven for real against a fake microphone.
 *
 * recorder.ts is renderer code — `MediaRecorder`, `getUserMedia`, the store —
 * so it is exercised here with each of those replaced by the smallest thing
 * that behaves like it. What is under test is the recorder's OWN sequencing,
 * which is where both B1 review findings lived:
 *
 * - a second click on Record while the first was still waiting on the
 *   permission check opened a second microphone (#4);
 * - a different project opened mid-take left the take landing in it, and the
 *   microphone open with no button to stop it (#3).
 */

interface FakeState {
  project: { id: string | undefined; tracks: { id: string; kind: string; name: string; locked: boolean }[]; settings: { sampleRate: number } }
  playhead: number
  recording: unknown
  notify: ReturnType<typeof vi.fn>
  setPlaying: ReturnType<typeof vi.fn>
  setRecording: ReturnType<typeof vi.fn>
  placeVoiceOver: ReturnType<typeof vi.fn>
}

const fake = vi.hoisted(() => ({
  state: null as unknown as FakeState,
  listeners: new Set<(s: FakeState) => void>()
}))

vi.mock('../../src/renderer/src/store', () => ({
  useEditor: {
    getState: () => fake.state,
    subscribe: (listener: (s: FakeState) => void) => {
      fake.listeners.add(listener)
      return () => fake.listeners.delete(listener)
    }
  }
}))
vi.mock('../../src/renderer/src/levels', () => ({ publishInput: vi.fn(), clearInput: vi.fn() }))

function setState(patch: Partial<FakeState>): void {
  fake.state = { ...fake.state, ...patch }
  for (const listener of [...fake.listeners]) listener(fake.state)
}

/** A MediaRecorder that records one chunk and stops when told. */
class FakeRecorder {
  static isTypeSupported = (): boolean => true
  static made = 0
  mimeType = 'audio/webm'
  private handlers: Record<string, ((e: { data: Blob }) => void)[]> = {}
  constructor() {
    FakeRecorder.made++
  }
  addEventListener(type: string, handler: (e: { data: Blob }) => void): void {
    ;(this.handlers[type] ??= []).push(handler)
  }
  start(): void {}
  stop(): void {
    const data = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' })
    queueMicrotask(() => {
      for (const h of this.handlers.dataavailable ?? []) h({ data })
      for (const h of this.handlers.stop ?? []) h({ data })
    })
  }
}

let permission: { resolve: (ok: boolean) => void } | null
let getUserMedia: ReturnType<typeof vi.fn>
let saveVoiceOver: ReturnType<typeof vi.fn>
let trackStops: number

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  fake.listeners.clear()
  fake.state = {
    project: {
      id: 'wedding',
      tracks: [{ id: 'a1', kind: 'audio', name: 'A1', locked: false }],
      settings: { sampleRate: 48000 }
    },
    playhead: 120,
    recording: null,
    notify: vi.fn(),
    setPlaying: vi.fn(),
    setRecording: vi.fn((recording: unknown) => setState({ recording })),
    placeVoiceOver: vi.fn(async () => undefined)
  }
  permission = null
  trackStops = 0
  FakeRecorder.made = 0
  getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: () => void trackStops++ }]
  }))
  saveVoiceOver = vi.fn(async () => '/voiceover/A1 take 1.wav')
  vi.stubGlobal('window', {
    forge: {
      // Held open until the test answers, so a second click can land inside it.
      microphonePermission: () => new Promise<boolean>((resolve) => (permission = { resolve })),
      saveVoiceOver
    }
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  // No level meter: the recorder must carry on without one.
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('no audio context here') } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function recorder(): Promise<typeof import('../../src/renderer/src/recorder')> {
  return import('../../src/renderer/src/recorder')
}

/** Answer the permission prompt, then run the three-second count-in. */
async function grantAndCountIn(): Promise<void> {
  await vi.waitFor(() => expect(permission).not.toBeNull())
  permission!.resolve(true)
  await vi.advanceTimersByTimeAsync(3_000)
}

describe('arming a take', () => {
  it('opens ONE microphone however fast Record is clicked twice', async () => {
    const { startVoiceOver, isRecording } = await recorder()
    const first = startVoiceOver('a1')
    // The second click lands while the first is still waiting on permission —
    // before any session exists. It must see the arming, not an empty slot.
    const second = startVoiceOver('a1')
    await grantAndCountIn()
    await Promise.all([first, second])

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeRecorder.made).toBe(1)
    expect(isRecording()).toBe(true)
  })

  it('can arm again after a refused permission', async () => {
    const { startVoiceOver } = await recorder()
    const refused = startVoiceOver('a1')
    await vi.waitFor(() => expect(permission).not.toBeNull())
    permission!.resolve(false)
    await refused
    // The arming flag must be cleared on the way out, or Record is dead for good.
    permission = null
    const again = startVoiceOver('a1')
    await grantAndCountIn()
    await again
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
})

describe('a take and the project it belongs to', () => {
  it('lands on the timeline when the same project is still open', async () => {
    const { startVoiceOver, stopVoiceOver } = await recorder()
    const started = startVoiceOver('a1')
    await grantAndCountIn()
    await started
    await stopVoiceOver()

    expect(saveVoiceOver).toHaveBeenCalledTimes(1)
    expect(fake.state.placeVoiceOver).toHaveBeenCalledWith('a1', '/voiceover/A1 take 1.wav', 120)
    expect(fake.state.recording).toBeNull()
  })

  it('leaves nothing listening to the store once a take is over', async () => {
    /*
     * The project watch is a store subscription. Left behind, it is inert — it
     * checks that its own session is still the current one — but it runs on
     * every store change for the rest of the session, one more per take.
     */
    const { startVoiceOver, stopVoiceOver } = await recorder()
    const kept = startVoiceOver('a1')
    await grantAndCountIn()
    await kept
    expect(fake.listeners.size).toBe(1)
    await stopVoiceOver()
    expect(fake.listeners.size).toBe(0)

    // And a take cancelled during the count-in lets go too.
    permission = null
    const cancelled = startVoiceOver('a1')
    await vi.waitFor(() => expect(permission).not.toBeNull())
    permission!.resolve(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await stopVoiceOver()
    await vi.advanceTimersByTimeAsync(3_000)
    await cancelled
    expect(fake.listeners.size).toBe(0)
  })

  it('stops, and keeps the take OFF the timeline, when another project opens mid-take', async () => {
    const { startVoiceOver, isRecording } = await recorder()
    const started = startVoiceOver('a1')
    await grantAndCountIn()
    await started
    expect(isRecording()).toBe(true)

    // File → Open: a different project, and the armed track is gone with it.
    setState({ project: { ...fake.state.project, id: 'birthday', tracks: [] } })
    await vi.waitFor(() => expect(fake.state.recording).toBeNull())

    // The microphone is closed — nobody could have reached the stop button.
    expect(isRecording()).toBe(false)
    expect(trackStops).toBe(1)
    // Saved, so nothing spoken is lost; not placed into an edit it was never
    // recorded against; and the person is told where it went.
    expect(saveVoiceOver).toHaveBeenCalledTimes(1)
    expect(fake.state.placeVoiceOver).not.toHaveBeenCalled()
    expect(fake.state.notify).toHaveBeenCalledWith(
      expect.stringContaining('/voiceover/A1 take 1.wav'),
      'info'
    )
  })

  it('cancels the count-in, recording nothing, when the project changes during it', async () => {
    const { startVoiceOver, isRecording } = await recorder()
    const started = startVoiceOver('a1')
    await vi.waitFor(() => expect(permission).not.toBeNull())
    permission!.resolve(true)
    await vi.advanceTimersByTimeAsync(1_000)
    setState({ project: { ...fake.state.project, id: 'birthday' } })
    await vi.advanceTimersByTimeAsync(3_000)
    await started

    expect(isRecording()).toBe(false)
    expect(FakeRecorder.made).toBe(0)
    expect(saveVoiceOver).not.toHaveBeenCalled()
    expect(trackStops).toBe(1)
  })
})
