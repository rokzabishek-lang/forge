/**
 * The Director eval's relay, in the harness page (tests/eval/relay.ts has the
 * server half and the reason it exists).
 *
 * A dumb loop on purpose: read the run's prepared requests, POST each body to
 * the model through the harness server's `/__lm` proxy exactly as node built
 * it, and write the raw answer back — status, time, and the server's JSON
 * untouched. Parsing, validating and scoring stay in node, where they are
 * tested. A request that already has an answer is skipped, so a run stopped
 * half way resumes where it was.
 *
 *   window.__forgeEvalRelay('<run>')         start (returns a promise)
 *   window.__forgeEvalProgress               { run, done, total, current, errors }
 *
 * And the one other thing node cannot do: draw type. The headline cards are
 * drawn by the app's own canvas renderer (textCanvas.ts), so an eval render
 * with them in it needs a browser. `cards.json` in the run lists each card's
 * spec and size (tests/eval/pipeline.ts `cardsOf`); each is drawn and written
 * back as the PNG the render then reads.
 *
 *   window.__forgeEvalCards('<run>')         draw every card (returns a promise)
 *   window.__forgeEvalCardsProgress          { run, done, total, errors, finished }
 */

import type { TextSpec } from '@shared/timeline'
import { renderTextPng } from '../textCanvas'

interface RelayRequest {
  id: string
  path: string
  body: unknown
}

interface Progress {
  run: string
  done: number
  total: number
  current: string | null
  errors: string[]
  finished: boolean
}

const file = (path: string): string => `/__eval/file?path=${encodeURIComponent(path)}`

async function relay(run: string): Promise<Progress> {
  const requests = (await (await fetch(file(`${run}/requests.json`))).json()) as RelayRequest[]
  const progress: Progress = { run, done: 0, total: requests.length, current: null, errors: [], finished: false }
  ;(window as unknown as { __forgeEvalProgress: Progress }).__forgeEvalProgress = progress

  for (const request of requests) {
    const target = `${run}/responses/${request.id}.json`
    const existing = await fetch(file(target))
    if (existing.ok) {
      progress.done++
      continue
    }
    progress.current = request.id
    const started = performance.now()
    let record: Record<string, unknown>
    try {
      const response = await fetch(`/__lm${request.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body)
      })
      const text = await response.text()
      const ms = Math.round(performance.now() - started)
      try {
        record = { id: request.id, status: response.status, ms, data: JSON.parse(text) as unknown }
      } catch {
        record = { id: request.id, status: response.status, ms, error: text.slice(0, 400) }
      }
    } catch (err) {
      record = {
        id: request.id,
        status: 0,
        ms: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err)
      }
      progress.errors.push(`${request.id}: ${String(record.error)}`)
    }
    await fetch(file(target), { method: 'PUT', body: JSON.stringify(record, null, 2) })
    progress.done++
  }
  progress.current = null
  progress.finished = true
  return progress
}

interface CardRequest {
  id: string
  /** Where the PNG goes, relative to the run. */
  file: string
  spec: TextSpec
  width: number
  height: number
}

interface CardsProgress {
  run: string
  done: number
  total: number
  errors: string[]
  finished: boolean
}

async function cards(run: string): Promise<CardsProgress> {
  const list = (await (await fetch(file(`${run}/cards.json`))).json()) as CardRequest[]
  const progress: CardsProgress = { run, done: 0, total: list.length, errors: [], finished: false }
  ;(window as unknown as { __forgeEvalCardsProgress: CardsProgress }).__forgeEvalCardsProgress = progress

  for (const card of list) {
    try {
      const png = await renderTextPng(card.spec, card.width, card.height)
      const put = await fetch(file(`${run}/${card.file}`), { method: 'PUT', body: png })
      if (!put.ok) throw new Error(`the harness server answered ${put.status}`)
    } catch (err) {
      progress.errors.push(`${card.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
    progress.done++
  }
  progress.finished = true
  return progress
}

export function installEvalRelay(): void {
  ;(window as unknown as { __forgeEvalRelay: typeof relay }).__forgeEvalRelay = relay
  ;(window as unknown as { __forgeEvalCards: typeof cards }).__forgeEvalCards = cards
}
