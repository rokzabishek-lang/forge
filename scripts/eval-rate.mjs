#!/usr/bin/env node
/**
 * `npm run eval:rate [run]` — the blind half of the Director eval.
 *
 * For each brief: the model's headlines and the standard cut's, shown as A and
 * B in an order fixed by the brief's id (so a re-run shows the same order,
 * and neither side is always first), each rated 1–5. Then the two renders,
 * copied to renders/blind/<brief>.A.mp4 and .B.mp4 so their names give nothing
 * away: which is better, and whether either looks automatic — and if so, why,
 * from the fixed list (docs/PLAN.md §0). The answers go into the run's file in
 * eval/runs/, beside what the model did. Already-rated briefs are skipped;
 * `--again` rates them afresh.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNS = join(REPO, 'eval', 'runs')
const REASONS = ['hero', 'hold', 'every-cut', 'rhythm', 'type', 'sound', 'copy', 'other']

/** A order that depends only on the brief: A is the model when the id's character sum is even. */
export function modelIsA(id) {
  let sum = 0
  for (const ch of id) sum += ch.codePointAt(0)
  return sum % 2 === 0
}

// spine@2 plans have shots; runs recorded before it have segments.
const headlinesOf = (plan) => (plan?.shots ?? plan?.segments ?? []).filter((s) => s.headline).map((s) => `  ${s.role.padEnd(8)} ${s.headline}`)

async function main() {
  const args = process.argv.slice(2)
  const again = args.includes('--again')
  const name = args.find((a) => !a.startsWith('--'))
  const files = existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort() : []
  const file = name ? `${name.replace(/\.json$/, '')}.json` : files.at(-1)
  if (!file || !existsSync(join(RUNS, file))) {
    console.error(name ? `No run called ${name} in eval/runs/` : 'No runs in eval/runs/ yet — run `npm run eval` first')
    process.exit(1)
  }
  const path = join(RUNS, file)
  const run = JSON.parse(readFileSync(path, 'utf8'))
  run.ratings ??= {}
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const ask = async (question, valid) => {
    for (;;) {
      const answer = (await rl.question(question)).trim().toLowerCase()
      if (valid(answer)) return answer
    }
  }
  const score = (label) => ask(`  ${label} — copy 1–5: `, (a) => /^[1-5]$/.test(a)).then(Number)

  console.log(`\n${run.run} — ${run.model}\n`)
  for (const result of run.results) {
    if (run.ratings[result.fixtureId] && !again) continue
    const aIsModel = modelIsA(result.fixtureId)
    const model = result.verdict === 'used' || result.verdict === 'repaired' ? result.applied : null
    const [a, b] = aIsModel ? [model, result.baseline] : [result.baseline, model]

    console.log(`— ${result.fixtureId} (${result.language}, ${result.tone}, ${result.seconds}s)`)
    console.log('A:')
    console.log(a ? headlinesOf(a).join('\n') || '  (no headlines)' : '  (the model\'s plan was rejected — the standard cut stood in)')
    console.log('B:')
    console.log(b ? headlinesOf(b).join('\n') || '  (no headlines)' : '  (the model\'s plan was rejected — the standard cut stood in)')
    const ratingA = await score('A')
    const ratingB = await score('B')
    const rating = { copy: aIsModel ? ratingA : ratingB, baselineCopy: aIsModel ? ratingB : ratingA }

    const renders = result.renders ?? {}
    if (renders.model && renders.baseline) {
      const blind = join(REPO, dirname(renders.model), 'blind')
      mkdirSync(blind, { recursive: true })
      const [fa, fb] = aIsModel ? [renders.model, renders.baseline] : [renders.baseline, renders.model]
      copyFileSync(join(REPO, fa), join(blind, `${result.fixtureId}.A.mp4`))
      copyFileSync(join(REPO, fb), join(blind, `${result.fixtureId}.B.mp4`))
      console.log(`  watch: ${join(blind, `${result.fixtureId}.A.mp4`)}`)
      console.log(`         ${join(blind, `${result.fixtureId}.B.mp4`)}`)
      const pick = await ask('  which is better — a, b, or same: ', (x) => ['a', 'b', 'same'].includes(x))
      rating.preferred = pick === 'same' ? 'same' : (pick === 'a') === aIsModel ? 'model' : 'baseline'
      const auto = await ask('  does either look automatic — a, b, both, none: ', (x) => ['a', 'b', 'both', 'none'].includes(x))
      rating.automatic = []
      for (const side of auto === 'both' ? ['a', 'b'] : auto === 'none' ? [] : [auto]) {
        const reason = await ask(`  ${side.toUpperCase()}: why — ${REASONS.join(' / ')}: `, (x) => REASONS.includes(x))
        const line = (await rl.question('  one line: ')).trim()
        rating.automatic.push({ which: (side === 'a') === aIsModel ? 'model' : 'baseline', reason, line })
      }
    }
    run.ratings[result.fixtureId] = rating
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`)
    console.log('')
  }
  rl.close()
  console.log(`Saved to eval/runs/${file}. Next: npm run eval:report`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
