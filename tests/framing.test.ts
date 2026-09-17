import { describe, it, expect } from 'vitest'
import {
  framingLadder,
  chooseFramings,
  fitRect,
  minCropHeight,
  overlap,
  ratioBetween,
  readsAsCut,
  MAX_UPSCALE,
  MIN_CROP_FRACTION
} from '@shared/automation/framing'
import type { CropRect } from '@shared/timeline'

const PHONE = { width: 4032, height: 3024 }
const VERTICAL = 1080 / 1920
const LANDSCAPE = 16 / 9
const OUT_TALL = { outputHeight: 1920 }

/** Someone standing left of centre, filling most of the height. */
const SUBJECT: CropRect = { x: 1100, y: 700, width: 900, height: 2000 }

const inside = (rect: CropRect, source = PHONE): boolean =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= source.width + 1 &&
  rect.y + rect.height <= source.height + 1

describe('fitRect', () => {
  it('matches the requested aspect', () => {
    expect(fitRect(2000, 1500, 1200, VERTICAL, PHONE).width / 1200).toBeCloseTo(VERTICAL, 2)
  })

  it('pushes a crop back inside rather than letting it hang off the edge', () => {
    // A crop running off the source renders as black bars, not as a close-up.
    for (const [cx, cy] of [
      [0, 0],
      [PHONE.width, PHONE.height],
      [-500, 5000]
    ]) {
      expect(inside(fitRect(cx, cy, 900, VERTICAL, PHONE))).toBe(true)
    }
  })

  it('never asks for more height than the source has', () => {
    expect(inside(fitRect(2000, 1500, 99999, LANDSCAPE, PHONE))).toBe(true)
  })
})

describe('minCropHeight', () => {
  it('is set by how far the crop gets enlarged, not by a fraction of the source', () => {
    // A fraction of the source cannot answer the only question that matters:
    // how soft will this look once it fills the canvas?
    expect(minCropHeight(PHONE, { outputHeight: 1920 })).toBeCloseTo(1920 / MAX_UPSCALE, 0)
    expect(minCropHeight(PHONE, { outputHeight: 1080 })).toBeCloseTo(1080 / MAX_UPSCALE, 0)
  })

  it('falls back to a fraction when the output size is unknown', () => {
    expect(minCropHeight(PHONE)).toBeCloseTo(PHONE.height * MIN_CROP_FRACTION, 0)
  })

  it('never demands more than the photograph has', () => {
    expect(minCropHeight({ width: 800, height: 600 }, { outputHeight: 1920 })).toBeLessThanOrEqual(600)
  })
})

describe('framingLadder', () => {
  it('frames the wide on the subject, not the middle of the photograph', () => {
    /*
     * The one that would ruin a reel silently: a vertical crop takes a third of
     * a landscape photo's width. Centred on the picture it can leave the person
     * outside the frame entirely.
     */
    const offLeft: CropRect = { x: 200, y: 700, width: 700, height: 2000 }
    const wide = framingLadder(PHONE, VERTICAL, offLeft, OUT_TALL)[0]
    const subjectCentre = offLeft.x + offLeft.width / 2
    expect(subjectCentre).toBeGreaterThanOrEqual(wide.rect.x)
    expect(subjectCentre).toBeLessThanOrEqual(wide.rect.x + wide.rect.width)
  })

  it('frames the close-up on the head, not the middle of the body', () => {
    // The centre of a standing person is their waist. Cropping there is the
    // most recognisable sign that nothing looked at the picture.
    const ladder = framingLadder({ width: 6000, height: 4000 }, VERTICAL, SUBJECT, OUT_TALL)
    const close = ladder.find((f) => f.label === 'close' || f.label === 'detail')
    expect(close).toBeDefined()
    const waist = SUBJECT.y + SUBJECT.height * 0.5
    const centre = close!.rect.y + close!.rect.height / 2
    expect(centre).toBeLessThan(waist)
  })

  it('offers a shot looking away when the picture has room for one', () => {
    // On a vertical reel there is almost nowhere to punch in, so coverage has
    // to come from moving across the picture instead.
    const ladder = framingLadder(PHONE, VERTICAL, SUBJECT, OUT_TALL)
    const aside = ladder.find((f) => f.label === 'aside')
    expect(aside).toBeDefined()
    expect(overlap(ladder[0].rect, aside!.rect)).toBeLessThan(0.5)
  })

  it('keeps every crop inside the photograph', () => {
    for (const aspect of [VERTICAL, LANDSCAPE]) {
      for (const subject of [SUBJECT, null]) {
        for (const framing of framingLadder(PHONE, aspect, subject, OUT_TALL)) {
          expect(inside(framing.rect)).toBe(true)
        }
      }
    }
  })

  it('never promises a shot the photograph lacks the pixels for', () => {
    const small = { width: 1600, height: 1200 }
    for (const framing of framingLadder(small, VERTICAL, SUBJECT, OUT_TALL)) {
      expect(framing.rect.height).toBeGreaterThanOrEqual(minCropHeight(small, OUT_TALL) - 1)
    }
  })

  it('always gives at least two distinct shots, even from a small photo', () => {
    // One rung is a slideshow of the same frame.
    for (const source of [PHONE, { width: 1600, height: 1200 }, { width: 6000, height: 4000 }]) {
      const ladder = framingLadder(source, VERTICAL, SUBJECT, OUT_TALL)
      expect(ladder.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('drops a rung that is the same size AND looking at the same thing', () => {
    const ladder = framingLadder(PHONE, LANDSCAPE, SUBJECT, { outputHeight: 1080 })
    for (let i = 0; i < ladder.length; i++) {
      for (let j = i + 1; j < ladder.length; j++) {
        const identical =
          ratioBetween(ladder[i], ladder[j]) < 1.02 && overlap(ladder[i].rect, ladder[j].rect) > 0.5
        expect(identical).toBe(false)
      }
    }
  })

  it('still builds a ladder with no subject, just a more cautious one', () => {
    const blind = framingLadder(PHONE, VERTICAL, null, OUT_TALL)
    expect(blind.length).toBeGreaterThan(1)
    // Slightly above centre, where faces are.
    const close = blind.find((f) => f.label === 'close')!
    expect(close.rect.y + close.rect.height / 2).toBeLessThan(PHONE.height / 2)
  })
})

describe('readsAsCut', () => {
  const a = { rect: { x: 0, y: 0, width: 1000, height: 1000 }, label: 'wide' as const, scale: 1 }

  it('accepts a big enough change of size', () => {
    const tight = { rect: { x: 300, y: 300, width: 400, height: 400 }, label: 'close' as const, scale: 2.5 }
    expect(readsAsCut(a, tight)).toBe(true)
  })

  it('accepts the same size looking somewhere else', () => {
    const beside = { rect: { x: 1200, y: 0, width: 1000, height: 1000 }, label: 'aside' as const, scale: 1 }
    expect(readsAsCut(a, beside)).toBe(true)
  })

  it('rejects a frame that barely twitched', () => {
    // This is the jump cut: the audience sees the edit, not the subject.
    const nudged = { rect: { x: 40, y: 40, width: 1000, height: 1000 }, label: 'wide' as const, scale: 1.05 }
    expect(readsAsCut(a, nudged)).toBe(false)
  })
})

describe('chooseFramings', () => {
  it('never puts two shots back to back that do not read as a cut', () => {
    for (const aspect of [VERTICAL, LANDSCAPE]) {
      const ladder = framingLadder(PHONE, aspect, SUBJECT, OUT_TALL)
      const sequence = chooseFramings(ladder, 8)
      expect(sequence).toHaveLength(8)
      for (let i = 1; i < sequence.length; i++) {
        expect(readsAsCut(sequence[i - 1], sequence[i])).toBe(true)
      }
    }
  })

  it('uses the whole ladder rather than ping-ponging between two rungs', () => {
    const ladder = framingLadder({ width: 6000, height: 4000 }, VERTICAL, SUBJECT, OUT_TALL)
    const labels = new Set(chooseFramings(ladder, 8).map((f) => f.label))
    expect(labels.size).toBe(ladder.length)
  })

  it('is deterministic, so rebuilding does not reshuffle what was watched', () => {
    const ladder = framingLadder(PHONE, VERTICAL, SUBJECT, OUT_TALL)
    expect(chooseFramings(ladder, 6)).toEqual(chooseFramings(ladder, 6))
  })

  it('copes with a ladder that collapsed to one rung', () => {
    const ladder = framingLadder(PHONE, VERTICAL, SUBJECT, OUT_TALL).slice(0, 1)
    expect(chooseFramings(ladder, 3)).toHaveLength(3)
  })

  it('gives nothing back for no shots', () => {
    expect(chooseFramings(framingLadder(PHONE, VERTICAL, SUBJECT, OUT_TALL), 0)).toEqual([])
    expect(chooseFramings([], 4)).toEqual([])
  })
})
