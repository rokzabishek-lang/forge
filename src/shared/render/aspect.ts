/**
 * The canvases a project can be cut for.
 *
 * Lives in shared rather than in the renderer store because it is a property of
 * the PROJECT, not of the window looking at it: the render plan sizes against
 * it, the crop solver reasons about it, and a saved file has to be able to say
 * which one it was cut for.
 */
export const ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: 'Landscape' },
  '9:16': { width: 1080, height: 1920, label: 'Vertical' },
  '1:1': { width: 1080, height: 1080, label: 'Square' }
} as const

export type AspectKey = keyof typeof ASPECTS

/**
 * Which aspect a project's settings describe.
 *
 * Matched on the RATIO rather than on exact pixels, so a project saved at some
 * other resolution of the same shape still opens as the shape it is.
 *
 * This exists because opening a file never restored the aspect: it is a slice of
 * its own, initialised to 16:9, while every reframe decision reads
 * `ASPECTS[aspect]` rather than `project.settings`. A saved 9:16 project reopened
 * into a fresh session therefore looked correct, and the next clip dropped onto
 * it was cropped to a horizontal rectangle inside a vertical frame — with
 * nothing on screen to explain why.
 */
export function aspectOf(settings: { width: number; height: number }): AspectKey {
  const ratio = settings.width / Math.max(1, settings.height)
  let best: AspectKey = '16:9'
  let closest = Infinity
  for (const key of Object.keys(ASPECTS) as AspectKey[]) {
    const a = ASPECTS[key]
    const distance = Math.abs(a.width / a.height - ratio)
    if (distance < closest) {
      closest = distance
      best = key
    }
  }
  return best
}
