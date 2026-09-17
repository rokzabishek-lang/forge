/**
 * Sidecar wire protocol — JSON-RPC 2.0 over stdio, newline-delimited.
 *
 * Why stdio rather than a local HTTP server:
 *  - no port allocation, so no conflicts with whatever else the user runs
 *  - no CORS, no auth, no listening socket to secure
 *  - the child dies with the parent automatically
 *  - **no macOS firewall prompt** — binding a socket makes the OS ask the user
 *    to allow incoming connections, which is alarming in a video editor
 *
 * Framing is one JSON object per line. That holds only because large payloads
 * never travel through the pipe: audio, video and model output go via file
 * paths on disk. Keep it that way — piping megabytes through stdio will stall
 * the event loop on both sides.
 */

export const PROTOCOL_VERSION = 1

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface RpcSuccess {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface RpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface RpcFailure {
  jsonrpc: '2.0'
  id: number
  error: RpcErrorBody
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type RpcMessage = RpcRequest | RpcSuccess | RpcFailure | RpcNotification

/** Server -> client, while a request is still running. */
export interface ProgressParams {
  id: number
  /** 0..1, or null when the work has no measurable total. */
  progress: number | null
  message?: string
}

/** Client -> server, asking a running request to stop. */
export interface CancelParams {
  id: number
}

export const METHOD_PROGRESS = 'progress'
export const METHOD_CANCEL = 'cancel'

/** JSON-RPC reserved codes, plus ours. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** The request was cancelled by the client. */
  cancelled: -32800,
  /** A capability is unavailable — model missing, dependency not installed. */
  unavailable: -32001
} as const

export function isResponse(message: RpcMessage): message is RpcSuccess | RpcFailure {
  return 'id' in message && typeof message.id === 'number' && !('method' in message)
}

export function isFailure(message: RpcMessage): message is RpcFailure {
  return isResponse(message) && 'error' in message
}

export function isNotification(message: RpcMessage): message is RpcNotification {
  return 'method' in message && !('id' in message)
}

export function encode(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Accumulates stdout chunks and yields whole messages.
 *
 * A chunk boundary can fall anywhere, including mid-character, so the caller
 * must hand every chunk to the same instance rather than parsing chunks
 * independently — that bug shows up only under load, when messages get large.
 */
export class LineDecoder {
  private buffer = ''

  push(chunk: string): RpcMessage[] {
    this.buffer += chunk
    const messages: RpcMessage[] = []

    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line !== '') {
        try {
          messages.push(JSON.parse(line) as RpcMessage)
        } catch {
          // A non-JSON line is almost always a stray print() or a warning from a
          // Python library. Dropping it is correct; crashing the pipe is not.
        }
      }
      newline = this.buffer.indexOf('\n')
    }
    return messages
  }

  /** Bytes held but not yet terminated by a newline. */
  get pending(): number {
    return this.buffer.length
  }

  reset(): void {
    this.buffer = ''
  }
}

/* ------------------------------------------------------- capability names */

export const SIDECAR_METHODS = {
  /** Handshake: returns protocol version, python version, available capabilities. */
  hello: 'system.hello',
  /** Liveness probe. */
  ping: 'system.ping',
  /** Transcribe audio: { path, language?, model? } -> word-level timestamps. */
  transcribe: 'asr.transcribe',
  /** Beats and musical structure: { path, startMs?, endMs? }. */
  beats: 'audio.beats',
  /** Cut a photo into depth planes for parallax: { path, ffmpeg, ffprobe, layers? }. */
  depthLayers: 'depth.layers',
  /**
   * Separate a song into a voice and an instrumental: { path, outDir? }.
   *
   * Optional, and degraded on most installs — it needs torch. The app falls
   * back to mid/side in the main process, which gives a real instrumental and
   * only an emphasised voice; the result's `quality` says which one answered.
   */
  stems: 'audio.stems'
} as const

export interface HelloResult {
  protocolVersion: number
  python: string
  platform: string
  capabilities: string[]
  /** Capabilities present but not usable, with the reason. */
  degraded: Record<string, string>
}
