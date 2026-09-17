/**
 * A stand-in for yt-dlp that speaks the same lines.
 *
 * The real thing needs a network and a binary we cannot fetch in CI. What can
 * be tested without either is everything around it: the argv we build, the
 * progress lines we parse, the marked lines we read back, the kill on cancel,
 * and the partial files that have to be gone before the promise settles.
 *
 * So this reads the arguments the way yt-dlp would — `-P`, `-o`, the progress
 * template, the two `--print`s — and plays the part: prints the title, writes a
 * `.part` file, emits progress through the caller's OWN template (substituting
 * the same fields yt-dlp would), renames into place, prints the final path.
 *
 * Knobs, via environment:
 *   FAKE_STEPS      progress lines to emit (default 5)
 *   FAKE_DELAY_MS   pause between them (default 20) — raise it to test cancel
 *   FAKE_EXT        extension of the finished file (default mp4)
 *   FAKE_FAIL       exit 1 with an ERROR line instead of finishing
 *   FAKE_NO_PRINT   finish without printing the path, to test the fallback
 *   FAKE_TITLE      the title to print (default has every Windows-illegal char)
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * slice(1), not slice(2).
 *
 * Under `node -e` there is no script path, so argv is [execPath, ...args] and
 * slice(2) silently dropped the first argument — the URL. The fake never read
 * it, so nothing failed; it just meant the integration test did not actually
 * prove the URL reaches the tool. It does now, and the check below fails loudly
 * if it ever stops.
 */
const argv = process.argv.slice(1)
const after = (flag) => {
  const at = argv.indexOf(flag)
  return at === -1 ? null : argv[at + 1]
}
const every = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))

const destDir = after('-P')
const template = after('-o') ?? '%(id)s.%(ext)s'
const progressTemplate = after('--progress-template') ?? ''
const prints = every('--print')

const steps = Number(process.env.FAKE_STEPS ?? 5)
const delay = Number(process.env.FAKE_DELAY_MS ?? 20)
const ext = process.env.FAKE_EXT ?? 'mp4'
const title = process.env.FAKE_TITLE ?? 'Fake | Title: "quoted"? *starred*'

if (!destDir) {
  process.stderr.write('ERROR: fake needs -P\n')
  process.exit(2)
}

/*
 * The URL has to be in there SOMEWHERE — but not necessarily first.
 *
 * yt-dlp's option parser takes flags before or after the positional argument,
 * so the fake must not invent an ordering the real tool does not have. What it
 * does assert is that a URL arrives at all: under `node -e` argv starts at the
 * first real argument, and an off-by-one here would silently mean the
 * integration tests never proved the link reaches the tool.
 */
if (!argv.some((a) => a.startsWith('http'))) {
  process.stderr.write(`ERROR: fake got no URL in ${JSON.stringify(argv.slice(0, 4))}\n`)
  process.exit(2)
}

const fill = (tpl, fields) =>
  tpl.replace(/%\(([a-z_.]+)\)s/g, (_, key) => (key in fields ? String(fields[key]) : 'NA'))

// yt-dlp prints the default-stage prints before downloading.
for (const p of prints) {
  if (!p.includes(':') || p.startsWith('@')) process.stdout.write(fill(p, { title }) + '\n')
}

mkdirSync(destDir, { recursive: true })
const finalName = fill(template, { ext, id: 'fake' })
const finalPath = join(destDir, finalName)
const partPath = join(destDir, finalName.replace(/\.[^.]+$/, `.f1.${ext}.part`))
writeFileSync(partPath, '')

const total = 100_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const progressBody = progressTemplate.replace(/^download:/, '')

for (let i = 1; i <= steps; i++) {
  await sleep(delay)
  const downloaded = Math.round((total * i) / steps)
  writeFileSync(partPath, Buffer.alloc(downloaded))
  process.stdout.write(
    fill(progressBody, {
      'progress.status': 'downloading',
      'progress.downloaded_bytes': downloaded,
      'progress.total_bytes': total,
      'progress.total_bytes_estimate': 'NA',
      'progress.speed': 2048.5,
      'progress.eta': steps - i
    }) + '\n'
  )
}

if (process.env.FAKE_FAIL) {
  process.stderr.write('[youtube] fake: Downloading webpage\n')
  process.stderr.write('ERROR: [youtube] fake: Video unavailable. This video is private\n')
  process.exit(1)
}

process.stdout.write(
  fill(progressBody, {
    'progress.status': 'finished',
    'progress.downloaded_bytes': total,
    'progress.total_bytes': total,
    'progress.total_bytes_estimate': 'NA',
    'progress.speed': 'NA',
    'progress.eta': 'NA'
  }) + '\n'
)

renameSync(partPath, finalPath)

if (!process.env.FAKE_NO_PRINT) {
  for (const p of prints) {
    if (p.startsWith('after_move:')) {
      process.stdout.write(fill(p.slice('after_move:'.length), { filepath: finalPath }) + '\n')
    }
  }
}
process.exit(0)
