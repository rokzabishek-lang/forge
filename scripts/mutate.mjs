/*
 * Mutation check: put each bug back, confirm the suite goes red.
 *
 *   node scripts/mutate.mjs <plan.json>
 *
 * Run from the root of the checkout to be mutated — ideally a separate git
 * worktree (`git worktree add <dir> <commit>` and a symlinked node_modules),
 * because this REWRITES source files while it runs and restores them at the
 * end. Editing the same checkout meanwhile, or adding a test file to it, fakes
 * kills; and a run killed half-way leaves its current mutation in place.
 *
 * The plan is { gate?: boolean, mutations: [{ file, name, from, to }] } with
 * `file` relative to the root. Anchors are asserted to match EXACTLY once
 * before anything is written — CLAUDE.md records three separate times a
 * mutation landed on the wrong occurrence of a repeated string and looked like
 * it had worked.
 *
 * Why this exists at all: four tests in this project were found asserting the
 * broken behaviour they were meant to guard (CLAUDE.md). A test that passes
 * with its bug put back certifies the bug.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))

const files = [...new Set(plan.mutations.map((m) => m.file))]
const originals = Object.fromEntries(files.map((f) => [f, readFileSync(resolve(ROOT, f), 'utf8')]))

function suite() {
  try {
    // npx is a .cmd on Windows, which Node will not spawn without a shell.
    execFileSync('npx', ['vitest', 'run'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: process.platform === 'win32',
      maxBuffer: 256 * 1024 * 1024
    })
    return { red: false, out: '' }
  } catch (e) {
    return { red: true, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/*
 * The gate. A red suite dies to every mutation and proves nothing, and a gate
 * that does not cover the file being mutated is not a gate — so it is the WHOLE
 * suite, every time.
 */
if (plan.gate !== false) {
  const { red, out } = suite()
  if (red) {
    console.log('GATE IS RED — nothing mutated. Fix the suite first.')
    console.log([...new Set([...out.matchAll(/FAIL\s+(\S+)/g)].map((x) => x[1]))].join('\n'))
    process.exit(2)
  }
  console.log('gate: green\n')
}

let survivors = 0
try {
  for (const m of plan.mutations) {
    const source = originals[m.file]
    const hits = source.split(m.from).length - 1
    if (hits !== 1) {
      console.log(`ANCHOR ${hits === 0 ? 'MISSED' : `MATCHED ${hits}x`} — ${m.name}`)
      survivors++
      continue
    }
    writeFileSync(resolve(ROOT, m.file), source.replace(m.from, m.to))
    const { red, out } = suite()
    writeFileSync(resolve(ROOT, m.file), source)

    const failing = [...new Set([...out.matchAll(/FAIL\s+(\S+)/g)].map((x) => x[1]))]
    const count = out.match(/Tests\s+(\d+) failed/)?.[1] ?? '?'
    console.log(
      red
        ? `KILLED   ${m.name}\n         ${count} failing, in ${failing.join(', ') || '(unreported)'}`
        : `SURVIVED ${m.name}`
    )
    if (!red) survivors++
  }
} finally {
  for (const f of files) writeFileSync(resolve(ROOT, f), originals[f])
}
console.log(survivors === 0 ? '\nAll mutations killed.' : `\n${survivors} SURVIVED.`)
process.exit(survivors === 0 ? 0 : 1)
