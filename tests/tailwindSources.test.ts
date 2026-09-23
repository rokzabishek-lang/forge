import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/*
 * Every file that writes Tailwind classes must be one Tailwind scans.
 *
 * Tailwind builds only the classes it finds in the files it scans, and it scans
 * from the renderer's root. The timeline's clip colours were written in
 * src/shared/edit/clipKind.ts, so none of them were ever built: every clip was
 * one uncoloured box, and a selected text or paper clip looked exactly like an
 * unselected one — reported from the app as "drag-select does not select text
 * or paper clips". Nothing failed; the classes were simply absent.
 */

const ROOT = resolve(__dirname, '..')
const STYLES = join(ROOT, 'src/renderer/src/styles.css')

/** Where Tailwind looks: the renderer itself, plus each `@source`. */
function scannedRoots(): string[] {
  const css = readFileSync(STYLES, 'utf8')
  const sources = [...css.matchAll(/^@source\s+"([^"]+)";/gm)].map((m) => resolve(dirname(STYLES), m[1]))
  return [join(ROOT, 'src/renderer'), ...sources]
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** A string that is plainly a Tailwind colour utility: `bg-sky-800/45`, `border-violet-300`. */
const UTILITY = /\b(?:bg|border|text|ring|from|to|via)-(?:[a-z]+)-\d{2,3}(?:\/\d{1,3})?\b/

const covered = (file: string, roots: string[]): boolean =>
  roots.some((root) => file === root || file.startsWith(root + sep))

describe('Tailwind builds the classes the app writes', () => {
  it('scans every source file that writes a colour utility', () => {
    const roots = scannedRoots()
    const writers = filesUnder(join(ROOT, 'src')).filter((file) => UTILITY.test(readFileSync(file, 'utf8')))
    // The check is about something: the clip colours ARE written outside the renderer.
    expect(writers.map((f) => relative(ROOT, f).split(sep).join('/'))).toContain('src/shared/edit/clipKind.ts')
    const missed = writers.filter((file) => !covered(file, roots)).map((f) => relative(ROOT, f))
    expect(missed, `classes written here are never built: ${missed.join(', ')}`).toEqual([])
  })
})
