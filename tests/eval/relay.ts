import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ProxyOptions } from 'vite'

/**
 * The eval's transport when the machine running the eval cannot reach the model.
 *
 * The Director eval (docs/PLAN.md §3) runs in three steps — prepare, ask, score
 * — and only ASK talks to the model. On the user's own machine it is a fetch
 * from node. In the development sandbox it cannot be: the shell is refused a
 * connection to localhost ("Operation not permitted", measured 2026-09-23),
 * while the in-app browser and the harness dev server reach it. So the harness
 * server carries two things, and nothing else:
 *
 *   /__lm/...           a proxy to the model server (LM Studio by default), so a
 *                       page on the harness origin can call it without CORS
 *   /__eval/file?path=  read and write JSON files under tests/output/eval/ —
 *                       the prepared requests going out, the raw responses
 *                       coming back — and NOWHERE else
 *
 * The browser then runs the dumb loop (`harness/evalRelay.ts`): read the
 * requests, POST each body to the proxy exactly as prepared, write the raw
 * answer back. Every decision stays in node, where it is tested.
 */

export const EVAL_ROOT = resolve(__dirname, '..', 'output', 'eval')

/** Where the relay's model server lives. LM Studio's default unless told otherwise. */
export const MODEL_SERVER = process.env.FORGE_EVAL_SERVER ?? 'http://127.0.0.1:1234'

/**
 * A relative path inside the eval folder, or null.
 *
 * Refuses absolute paths, `..` that climbs out, and anything that resolves to
 * the folder itself — a dev server that writes files is exactly the thing that
 * must not be talked into writing somewhere else.
 */
export function evalPath(requested: string | null | undefined, root = EVAL_ROOT): string | null {
  if (!requested || requested.includes('\0') || isAbsolute(requested)) return null
  const full = resolve(root, requested)
  const rel = relative(root, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
  return full
}

/** Largest body the relay accepts: a request with a handful of 640-px images is well under this. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.end(body)
}

export async function handleEvalFile(req: IncomingMessage, res: ServerResponse, root = EVAL_ROOT): Promise<void> {
  const url = new URL(req.url ?? '', 'http://harness')
  const path = evalPath(url.searchParams.get('path'), root)
  if (!path) return send(res, 400, 'path must be relative and inside tests/output/eval')
  try {
    if (req.method === 'GET') {
      const body = await readFile(path, 'utf8')
      return send(res, 200, body, 'application/json')
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
      return send(res, 204, '')
    }
    return send(res, 405, 'GET or PUT')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return send(res, code === 'ENOENT' ? 404 : 500, err instanceof Error ? err.message : String(err))
  }
}

/** The harness server's half of the relay. */
export function evalRelay(): Plugin {
  return {
    name: 'forge-eval-relay',
    configureServer(server) {
      server.middlewares.use('/__eval/file', (req, res) => {
        void handleEvalFile(req, res)
      })
    }
  }
}

export const modelProxy: Record<string, ProxyOptions> = {
  '/__lm': {
    target: MODEL_SERVER,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/__lm/, ''),
    // A plan on a CPU box takes tens of seconds; the proxy must not give up first.
    timeout: 300_000,
    proxyTimeout: 300_000
  }
}
