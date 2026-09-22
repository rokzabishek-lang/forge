/**
 * The preview's mixer.
 *
 * Until this existed, every audio element played at `element.volume = clip.volume`
 * and nothing else: no envelope, no fades, no crossfade at an overlap, no
 * ducking under dialogue. So the one judgement people make while editing — *is
 * the music too loud under the voice* — could only be made by exporting, and
 * every level decision was taken against a mix that was not the mix.
 *
 * The shape is the ordinary one:
 *
 *     element → MediaElementAudioSourceNode → clip gain → track gain
 *                                                            ↓
 *                          destination ← analyser ← master gain
 *
 * `element.volume` stays at 1 throughout. Every level is a `GainNode`, because
 * levels have to multiply — a clip's envelope times its fade times its track's
 * duck — and an element's own volume cannot participate in that.
 *
 * Two things a browser forces on this. A `MediaElementAudioSourceNode` can be
 * created only ONCE per element and permanently reroutes it, so the map of them
 * is the authority on what has been connected and an element that has been
 * through here can never go back to playing on its own. And an `AudioContext`
 * starts suspended until a gesture, so `resume()` is called on every play
 * rather than once at construction.
 */

import { DUCK, duckStep } from '@shared/render/duck'

/** A level meter's reading, for the transport's meters. */
export interface Levels {
  /** 0..1, the loudest sample in the last analysis window. */
  peak: number
  /** The ducker's current gain, 1 when nothing is being pushed down. */
  duck: number
}

interface ClipNodes {
  source: MediaElementAudioSourceNode
  gain: GainNode
}

export class PreviewMixer {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  /** Reads the dialogue sum only, which is what the duck is keyed off. */
  private keyAnalyser: AnalyserNode | null = null
  private keyBus: GainNode | null = null
  private duckBus: GainNode | null = null

  private readonly clips = new Map<string, ClipNodes>()
  private readonly tracks = new Map<string, GainNode>()

  private duckGain = 1
  private lastStep = 0
  // Explicitly over an ArrayBuffer: `getFloatTimeDomainData` will not take a
  // view onto a SharedArrayBuffer, which is what the bare type allows.
  private samples: Float32Array<ArrayBuffer> | null = null

  /**
   * Built on first use, not at construction.
   *
   * Creating an AudioContext before a gesture leaves it suspended and, in some
   * browsers, logs a warning on every load of an editor that may never play
   * anything.
   */
  private ensure(): AudioContext | null {
    if (this.context) return this.context
    const Ctor: typeof AudioContext | undefined =
      typeof window === 'undefined'
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
    if (!Ctor) return null

    const context = new Ctor()
    const master = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024

    /*
     * The dialogue bus is a DEAD END that only the key analyser listens to.
     *
     * Dialogue reaches the speakers through its own track gain like everything
     * else; this is a second, silent copy purely so the ducker has something to
     * measure — the same split the render makes with `asplit=2[dia_out][dia_key]`.
     * Its gain is zero so nothing is heard twice.
     */
    const keyBus = context.createGain()
    keyBus.gain.value = 1
    const keyAnalyser = context.createAnalyser()
    keyAnalyser.fftSize = 1024
    keyBus.connect(keyAnalyser)

    // Music passes through here so the follower has one place to write.
    const duckBus = context.createGain()
    duckBus.gain.value = 1
    duckBus.connect(master)

    master.connect(analyser)
    analyser.connect(context.destination)

    this.context = context
    this.master = master
    this.analyser = analyser
    this.keyAnalyser = keyAnalyser
    this.keyBus = keyBus
    this.duckBus = duckBus
    this.samples = new Float32Array(analyser.fftSize)
    return context
  }

  /** Let the context run. Browsers keep it suspended until a gesture. */
  resume(): void {
    const context = this.ensure()
    if (context?.state === 'suspended') void context.resume().catch(() => undefined)
  }

  /**
   * Route one element through the graph, once.
   *
   * `kind` decides which bus it joins: music is ducked, dialogue is measured,
   * everything else goes straight to master. Returns false when the browser
   * refuses — a cross-origin element, most often — and the caller then leaves
   * `element.volume` doing the job it did before.
   */
  attach(clipId: string, element: HTMLMediaElement, trackId: string): boolean {
    const context = this.ensure()
    if (!context || !this.master) return false
    if (this.clips.has(clipId)) return true

    try {
      const source = context.createMediaElementSource(element)
      const gain = context.createGain()
      source.connect(gain)
      gain.connect(this.trackGain(trackId))
      // Volume lives in the graph now; leaving it on the element too would
      // apply every level twice.
      element.volume = 1
      this.clips.set(clipId, { source, gain })
      return true
    } catch {
      return false
    }
  }

  private trackGain(trackId: string): GainNode {
    const existing = this.tracks.get(trackId)
    if (existing) return existing
    const context = this.ensure()!
    const gain = context.createGain()
    gain.connect(this.master!)
    this.tracks.set(trackId, gain)
    return gain
  }

  /**
   * Where a track's sound goes, which is what makes ducking possible at all.
   *
   * Re-pointing rather than adding: a track that becomes music must stop
   * reaching master directly or it would be heard twice, once ducked and once
   * not.
   */
  routeTrack(trackId: string, role: 'music' | 'dialogue' | 'other'): void {
    if (!this.ensure()) return
    const gain = this.trackGain(trackId)
    gain.disconnect()
    if (role === 'music') gain.connect(this.duckBus!)
    else gain.connect(this.master!)
    // Dialogue additionally feeds the silent key bus, so the follower can hear
    // it without it being heard twice.
    if (role === 'dialogue') gain.connect(this.keyBus!)
  }

  setClipGain(clipId: string, value: number): void {
    const nodes = this.clips.get(clipId)
    if (!nodes) return
    const safe = Math.max(0, Math.min(4, value))
    /*
     * Ramped, not assigned.
     *
     * A gain written straight sixty times a second steps, and steps in a gain
     * are clicks — the very thing the fades exist to remove. A short ramp to
     * the next value is inaudible and makes the envelope continuous.
     */
    const at = this.context!.currentTime
    nodes.gain.gain.setTargetAtTime(safe, at, 0.01)
  }

  setTrackGain(trackId: string, value: number): void {
    if (!this.ensure()) return
    const gain = this.trackGain(trackId)
    gain.gain.setTargetAtTime(Math.max(0, Math.min(4, value)), this.context!.currentTime, 0.01)
  }

  /** Detach a clip that no longer exists. */
  forget(clipId: string): void {
    const nodes = this.clips.get(clipId)
    if (!nodes) return
    try {
      nodes.source.disconnect()
      nodes.gain.disconnect()
    } catch {
      // A context that has already closed throws here and there is nothing to
      // clean up, which is the outcome either way.
    }
    this.clips.delete(clipId)
  }

  has(clipId: string): boolean {
    return this.clips.has(clipId)
  }

  /**
   * Advance the ducker and read the meters. Called once per drawn frame.
   *
   * The level is the loudest sample in the analyser's window rather than an
   * RMS: a compressor keyed off speech has to react to the attack of a word,
   * and an averaged level arrives after it.
   */
  step(nowMs: number): Levels {
    if (!this.context || !this.analyser || !this.keyAnalyser || !this.samples) {
      return { peak: 0, duck: 1 }
    }
    const elapsed = this.lastStep === 0 ? 16 : Math.max(0, Math.min(250, nowMs - this.lastStep))
    this.lastStep = nowMs

    const peakOf = (node: AnalyserNode): number => {
      node.getFloatTimeDomainData(this.samples!)
      let peak = 0
      for (const sample of this.samples!) {
        const magnitude = Math.abs(sample)
        if (magnitude > peak) peak = magnitude
      }
      return peak
    }

    this.duckGain = duckStep(this.duckGain, peakOf(this.keyAnalyser), elapsed, DUCK)
    this.duckBus?.gain.setTargetAtTime(this.duckGain, this.context.currentTime, 0.01)

    return { peak: peakOf(this.analyser), duck: this.duckGain }
  }

  close(): void {
    for (const id of [...this.clips.keys()]) this.forget(id)
    this.tracks.clear()
    void this.context?.close().catch(() => undefined)
    this.context = null
  }
}
