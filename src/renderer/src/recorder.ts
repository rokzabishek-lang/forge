/**
 * Recording a voice-over: the microphone, the count-in, the take.
 *
 * Outside the store because none of it is state the editor owns — a
 * `MediaStream`, a `MediaRecorder`, an `AudioContext` for the level — and none
 * of it can be serialised or undone. The store holds only what the interface
 * draws (`recording`), and this module drives it.
 *
 * The sequence is the one every NLE uses: arm, count three, record while the
 * edit plays so the voice can be timed to the picture, stop, and the take lands
 * at the frame recording began.
 *
 * Two limits, stated rather than hidden:
 * - **Latency.** `MediaRecorder.start()` and playback starting are not
 *   sample-locked, so a take can land a few tens of milliseconds off. Nudging
 *   it (Alt+arrow) fixes it; a measured compensation is a later refinement.
 * - **Headphones.** With speakers, the microphone hears the edit playing back.
 *   Chromium's echo cancellation is left ON for exactly that case, and noise
 *   suppression and auto-gain are turned OFF, because both pump audibly on a
 *   voice and there is no undoing them afterwards.
 */

import { COUNT_IN_SECONDS, recorderType, takeName } from '@shared/render/voiceover'
import { useEditor } from './store'
import { clearInput, publishInput } from './levels'

interface Session {
  trackId: string
  /**
   * The project the take was recorded into. If a different project is open by
   * the time the take is saved, it is NOT placed — it would land in an edit it
   * was never recorded against. Found by the B1 review.
   */
  projectId: string | undefined
  /** Stops the recording if the project changes underneath it. */
  unsubscribe: () => void
  stream: MediaStream
  recorder: MediaRecorder | null
  chunks: Blob[]
  meter: { context: AudioContext; raf: number } | null
  startFrame: number
  cancelled: boolean
}

let session: Session | null = null
let takes = 0
/**
 * True from the first click until the session exists.
 *
 * `session` is only set after two awaits — the permission check and
 * `getUserMedia` — so a second click inside that window saw no session and
 * started another: two microphones open, and the first one's stream, context
 * and meter loop leaked for good. Set synchronously, before anything awaits.
 */
let arming = false

/** Show the microphone's level on the armed track's meter, from the moment it opens. */
function watchLevel(trackId: string, stream: MediaStream): Session['meter'] {
  try {
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    const meter = { context, raf: 0 }
    const tick = (): void => {
      analyser.getFloatTimeDomainData(samples)
      let peak = 0
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
      publishInput(trackId, peak, performance.now())
      meter.raf = requestAnimationFrame(tick)
    }
    meter.raf = requestAnimationFrame(tick)
    return meter
  } catch {
    // No level is a smaller loss than no recording.
    return null
  }
}

function release(s: Session): void {
  s.unsubscribe()
  if (s.meter) {
    cancelAnimationFrame(s.meter.raf)
    void s.meter.context.close().catch(() => undefined)
  }
  for (const track of s.stream.getTracks()) track.stop()
  clearInput(s.trackId)
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Arm a track, count in, and start recording over the edit. */
export async function startVoiceOver(trackId: string): Promise<void> {
  const store = useEditor.getState()
  if (session || arming) return
  const track = store.project.tracks.find((t) => t.id === trackId)
  if (!track || track.kind !== 'audio' || track.locked) {
    store.notify('Record onto an audio track that is not locked', 'info')
    return
  }

  arming = true
  let stream: MediaStream
  try {
    if (!(await window.forge.microphonePermission())) {
      store.notify(
        'Forge is not allowed to use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.'
      )
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
      })
    } catch (err) {
      store.notify(`The microphone could not be opened: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  } finally {
    arming = false
  }

  const projectId = useEditor.getState().project.id
  const current: Session = {
    trackId,
    projectId,
    /*
     * A different project opened mid-take stops the recording.
     *
     * Otherwise the armed track no longer exists, so its stop button is gone,
     * and every other record button stays disabled because a recording is
     * still "in progress" — a microphone left open with no way to close it.
     */
    unsubscribe: useEditor.subscribe((state) => {
      if (state.project.id !== projectId && session === current) void stopVoiceOver()
    }),
    stream,
    recorder: null,
    chunks: [],
    meter: watchLevel(trackId, stream),
    startFrame: store.playhead,
    cancelled: false
  }
  session = current

  // The count-in. Stopped mid-count, nothing is recorded and nothing lands.
  store.setPlaying(false)
  for (let count = COUNT_IN_SECONDS; count > 0; count--) {
    useEditor.getState().setRecording({ trackId, phase: 'counting', count })
    await wait(1000)
    if (current.cancelled) return
  }

  const mimeType = recorderType((t) => MediaRecorder.isTypeSupported(t))
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) current.chunks.push(event.data)
  })
  current.recorder = recorder
  current.startFrame = useEditor.getState().playhead

  recorder.start()
  useEditor.getState().setRecording({ trackId, phase: 'recording', count: 0 })
  // Playback while recording, so the voice can be timed to the picture.
  useEditor.getState().setPlaying(true)
}

/** Stop — keeps the take — or cancel during the count-in, which keeps nothing. */
export async function stopVoiceOver(): Promise<void> {
  const current = session
  if (!current) return
  session = null
  const store = useEditor.getState()
  store.setPlaying(false)

  if (!current.recorder) {
    current.cancelled = true
    release(current)
    store.setRecording(null)
    return
  }

  const recorder = current.recorder
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener('stop', () => resolve(), { once: true })
  )
  recorder.stop()
  await stopped
  release(current)
  store.setRecording({ trackId: current.trackId, phase: 'saving', count: 0 })

  try {
    const blob = new Blob(current.chunks, { type: recorder.mimeType || 'audio/webm' })
    if (blob.size === 0) throw new Error('nothing was recorded')
    const project = useEditor.getState().project
    const track = project.tracks.find((t) => t.id === current.trackId)
    takes += 1
    const path = await window.forge.saveVoiceOver(
      await blob.arrayBuffer(),
      takeName(track?.name ?? 'Voice-over', takes, Date.now()),
      project.settings.sampleRate
    )
    if (useEditor.getState().project.id !== current.projectId) {
      // Saved, not placed: it belongs to an edit that is no longer open.
      useEditor
        .getState()
        .notify(`The project changed while you were recording. The take is kept at ${path}.`, 'info')
      return
    }
    await useEditor.getState().placeVoiceOver(current.trackId, path, current.startFrame)
  } catch (err) {
    useEditor.getState().notify(`The take could not be saved: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    useEditor.getState().setRecording(null)
  }
}

export function isRecording(): boolean {
  return session !== null
}
