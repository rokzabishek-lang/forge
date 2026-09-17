import { describe, it, expect } from 'vitest'
import { concatPath, concatList, type CaptionBakePlan } from '@shared/captions/bake'

/*
 * Paths, as the concat demuxer reads them.
 *
 * Every one of these is a Windows failure that a Mac never sees, which is what
 * makes them worth a test rather than a run on the other laptop.
 */

describe('concatPath', () => {
  it('turns a Windows path into one the demuxer reads back correctly', () => {
    /*
     * The real bug. Backslash is an escape character to the demuxer, inside
     * quotes as much as out, so `C:\Users\spyker` arrives as a path with a tab
     * and a form feed in it and the render fails on a missing file.
     */
    const out = concatPath('C:\\Users\\spyker\\AppData\\caption-bake\\00001.png')
    expect(out).toBe("'C:/Users/spyker/AppData/caption-bake/00001.png'")
    expect(out).not.toContain('\\U')
  })

  it('leaves a POSIX path alone apart from the quotes', () => {
    expect(concatPath('/Users/spyker/Library/caption-bake/00001.png')).toBe(
      "'/Users/spyker/Library/caption-bake/00001.png'"
    )
  })

  it('quotes a path with spaces in it, which is the common case here', () => {
    // The project this ships from lives in "/Users/spyker/my claude".
    expect(concatPath('/Users/spyker/my claude/out/00001.png')).toBe(
      "'/Users/spyker/my claude/out/00001.png'"
    )
  })

  it('does not let a quote in the path end the quoting early', () => {
    const out = concatPath("/tmp/it's here/00001.png")
    expect(out).toBe("'/tmp/it'\\''s here/00001.png'")
    // Opens and closes cleanly: an odd number of bare quotes would not.
    expect(out.startsWith("'")).toBe(true)
    expect(out.endsWith("'")).toBe(true)
  })
})

describe('concatList', () => {
  const plan: CaptionBakePlan = {
    runs: [
      { picture: 0, frames: 30 },
      { picture: 1, frames: 15 }
    ],
    pictures: [],
    totalFrames: 45
  }

  it('writes Windows paths the demuxer can open', () => {
    const list = concatList(plan, 30, (n) => `C:\\Users\\x\\${n}.png`)
    expect(list).not.toContain('\\')
    expect(list).toContain("file 'C:/Users/x/0.png'")
  })

  it('still repeats the last picture, which the demuxer needs', () => {
    // The final `duration` is ignored, so without a repeat the last caption
    // flashes for one frame instead of being held.
    const list = concatList(plan, 30, (n) => `/tmp/${n}.png`)
    const files = list.split('\n').filter((l) => l.startsWith('file '))
    expect(files).toHaveLength(3)
    expect(files[2]).toBe(files[1])
  })
})
