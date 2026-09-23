/** Types for scripts/eval-report.mjs, so the tests can import it under strict TypeScript. */

export interface RunSummary {
  briefs: number
  used: number
  repaired: number
  rejected: number
  error: number
  landed: number
  medianMs: number | null
  medianPrompt: number | null
  medianOutput: number | null
  headlines: number
  headlinesFit: number
  copy: number | null
  baselineCopy: number | null
  rated: number
  preferred: number
  preferredOf: number
  reasons: Record<string, number>
}

export function summarise(run: unknown): RunSummary
export function meetsBar(summary: RunSummary): boolean | null
export function buildReport(runs: unknown[], findings?: string): string
export function loadRuns(dir?: string): unknown[]
