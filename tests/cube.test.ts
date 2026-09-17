import { describe, it, expect } from 'vitest'
import { parseCube, sampleNearest, CubeError, MAX_CUBE_SIZE } from '@shared/render/cube'

/** Identity at size 2, red varying fastest. */
const IDENTITY = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`

/** Swaps red and blue — asymmetric, so a wrong axis order is visible. */
const SWAP = `TITLE "Swap"
# a comment
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`

describe('parseCube', () => {
  it('reads the size and the table', () => {
    const lut = parseCube(IDENTITY)
    expect(lut.size).toBe(2)
    expect(lut.data).toHaveLength(8 * 3)
  })

  it('reads the title and ignores comments', () => {
    expect(parseCube(SWAP).title).toBe('Swap')
  })

  /*
   * The axis order is the bug that ships.
   *
   * Red varies fastest, then green, then blue. Reversed, the LUT still loads,
   * still looks plausible on greys, and is wrong on every other colour.
   */
  it('reads entries red-fastest', () => {
    const lut = parseCube(SWAP)
    // Pure red in must come out pure blue.
    expect(sampleNearest(lut, 1, 0, 0)).toEqual([0, 0, 1])
    // And pure blue must come out red, not stay blue.
    expect(sampleNearest(lut, 0, 0, 1)).toEqual([1, 0, 0])
  })

  it('leaves colours alone through an identity LUT', () => {
    const lut = parseCube(IDENTITY)
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 1],
      [1, 1, 1]
    ]
    for (const [r, g, b] of cases) {
      expect(sampleNearest(lut, r, g, b)).toEqual([r, g, b])
    }
  })

  it('honours a domain other than 0..1', () => {
    const lut = parseCube(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n${IDENTITY.split('\n').slice(1).join('\n')}`)
    expect(lut.domainMax).toEqual([2, 2, 2])
    // Halfway up a 0..2 domain is the middle of the table, not the top.
    expect(sampleNearest(lut, 2, 0, 0)).toEqual([1, 0, 0])
  })

  describe('refusing bad files', () => {
    it('says so when the entry count does not match the declared size', () => {
      // Silently padding would put a wrong look on every export.
      expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(CubeError)
    })

    it('names a 1D LUT rather than misreading it as 3D', () => {
      expect(() => parseCube('LUT_1D_SIZE 32\n0 0 0\n')).toThrow(/1D LUT/)
    })

    it('rejects a file with no size at all', () => {
      expect(() => parseCube('hello\nworld\n')).toThrow(/not be a .cube/)
    })

    it('refuses a cube too large to upload', () => {
      expect(() => parseCube(`LUT_3D_SIZE ${MAX_CUBE_SIZE + 1}\n`)).toThrow(/limit/)
    })
  })

  it('survives CRLF line endings, which is what Windows tools write', () => {
    expect(parseCube(IDENTITY.replace(/\n/g, '\r\n')).size).toBe(2)
  })
})
