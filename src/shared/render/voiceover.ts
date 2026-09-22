/**
 * Voice-over: recording straight into the edit.
 *
 * The one thing every short-form editor has on its first screen and this one
 * did not: talk over the picture while it plays, and have what you said land on
 * the timeline where you said it. Without it, a voice-over meant a second app,
 * a file export, a drag back in, and lining it up by eye.
 *
 * The browser records what it can — `MediaRecorder` gives WebM/Opus in Chromium
 * — and the bundled ffmpeg turns that into a WAV before it becomes an asset.
 * WAV because it is the one format every part of this app already reads without
 * question: the waveform, the probe, both ffmpegs, every filter. Opus-in-WebM is
 * decodable by the 2018 Windows build, but a recording is the user's own voice
 * and there is no second take of it, so the file that is kept is the one with
 * no codec to go wrong.
 *
 * Every argument below is from before the 2018-12-17 floor: `pcm_s16le`, `-ar`,
 * `-ac`, `-vn` are ffmpeg's oldest options.
 */

/** What the recorder asks the browser for, in the order it would like them. */
export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'] as const

/** The first of those this browser will actually record, or '' for its default. */
export function recorderType(supported: (type: string) => boolean): string {
  return RECORDER_TYPES.find((t) => supported(t)) ?? ''
}

/**
 * The ffmpeg arguments that turn a recording into the WAV that is kept.
 *
 * Mono, because a voice is one voice and a microphone is one microphone; a
 * stereo file of it is the same channel twice and twice the disk. At the
 * PROJECT's rate, so nothing downstream has to resample it.
 *
 * `-vn` because some Chromium builds put an empty video track in a WebM made
 * from an audio-only stream, and a WAV cannot hold one.
 */
export function voiceOverArgs(input: string, output: string, sampleRate: number): string[] {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 48000
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', String(rate),
    '-c:a', 'pcm_s16le',
    output
  ]
}

/**
 * The file name for a take — a name, and safe on both platforms.
 *
 * Numbered by the take, which is how anyone who has recorded more than once
 * refers to them ("the third one was better"), and stamped so two sessions do
 * not collide. Only characters Windows allows in a filename, because the track
 * name comes from the user and `VO: intro` is an ordinary thing to call one.
 */
export function takeName(trackName: string, take: number, stamp: number): string {
  const safe = trackName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 32)
  return `${safe || 'Voice-over'} take ${Math.max(1, Math.round(take))} ${stamp.toString(36)}`
}

/**
 * The name the MAIN process gives a take on disk, from whatever the renderer sent.
 *
 * `takeName` above is what the renderer asks for; this is what the main
 * process accepts, because the name crosses the IPC and reaches a file path —
 * `../../somewhere` has to become a name, not a place. So: the last path
 * segment only, Windows' illegal set out, no leading or trailing dots and
 * spaces, and never a reserved device name. `CON.wav` is not a file on
 * Windows whatever its extension; it is the console.
 *
 * Empty after all that means the caller picks the name (`fallback`).
 */
export function safeTakeBase(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback
  const lastSegment = name.split(/[/\\]/).pop() ?? ''
  const cleaned = lastSegment
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  if (!cleaned) return fallback
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned
}

/** A three-count before recording starts: long enough to breathe, short enough not to wait. */
export const COUNT_IN_SECONDS = 3
