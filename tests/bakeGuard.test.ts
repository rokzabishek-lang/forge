import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginBake,
  endBake,
  isBaking,
  isSuperseded,
  resetBakeGuard
} from '@shared/bakeGuard'

/*
 * The overlap this exists to stop, measured rather than imagined.
 *
 * On a cold start with a restored project, two bakes of the same clipping ran
 * at once and the main process logged
 *
 *   ENOENT: no such file or directory, open '…\paper-….seq\00003.png'
 *
 * from a WRITE, not a read — the newer bake's `rm` landing between the older
 * one's `mkdir` and its `writeFile`. That is the loud case. The quiet one is
 * the older bake simply carrying on, filling the newer bake's directory with
 * frames of a different render, which nothing reports at all.
 */
describe('bakeGuard', () => {
  beforeEach(() => resetBakeGuard())

  it('leaves the only bake of a clip alone', () => {
    const token = beginBake('clip-a')
    expect(isSuperseded('clip-a', token)).toBe(false)
    endBake('clip-a')
  })

  it('supersedes the older bake the moment a newer one starts', () => {
    const first = beginBake('clip-a')
    const second = beginBake('clip-a')

    // The older one must stop; the newer one owns the clip.
    expect(isSuperseded('clip-a', first)).toBe(true)
    expect(isSuperseded('clip-a', second)).toBe(false)
  })

  it('keeps clips independent, so one clipping cannot cancel another', () => {
    const a = beginBake('clip-a')
    beginBake('clip-b')
    expect(isSuperseded('clip-a', a)).toBe(false)
  })

  it('reports a bake in flight until it ends', () => {
    expect(isBaking('clip-a')).toBe(false)
    beginBake('clip-a')
    expect(isBaking('clip-a')).toBe(true)
    endBake('clip-a')
    expect(isBaking('clip-a')).toBe(false)
  })

  it('stays in flight while the superseded bake is still unwinding', () => {
    /*
     * The case store.ts depends on. Two bakes overlap; the older returns
     * nothing because it was superseded, and the caller must NOT read that as
     * "there is no animation" and clear the frames the newer one is writing.
     */
    beginBake('clip-a')
    beginBake('clip-a')
    endBake('clip-a') // the superseded one gives up first
    expect(isBaking('clip-a')).toBe(true)
    endBake('clip-a') // the live one finishes
    expect(isBaking('clip-a')).toBe(false)
  })

  it('does not go negative when a bake ends twice', () => {
    beginBake('clip-a')
    endBake('clip-a')
    endBake('clip-a')
    expect(isBaking('clip-a')).toBe(false)
    // And a later bake still reads as in flight rather than being cancelled
    // out by the stray end.
    beginBake('clip-a')
    expect(isBaking('clip-a')).toBe(true)
  })

  it('an ended bake is still superseded, so a late write cannot slip through', () => {
    const first = beginBake('clip-a')
    beginBake('clip-a')
    endBake('clip-a')
    endBake('clip-a')
    // Nothing is baking, but the old token must never look current again.
    expect(isBaking('clip-a')).toBe(false)
    expect(isSuperseded('clip-a', first)).toBe(true)
  })

  it('a token from before a reset is not mistaken for the current one', () => {
    const stale = beginBake('clip-a')
    resetBakeGuard()
    expect(isSuperseded('clip-a', stale)).toBe(true)
  })
})
