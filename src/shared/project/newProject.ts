/**
 * The first decision, asked instead of assumed.
 *
 * `DEFAULT_SETTINGS` is 1920×1080, so every project started landscape — and
 * this app is for reels, product demos and short-form ads, where the answer is
 * 9:16 nearly every time. Someone arriving to make a vertical ad got a
 * horizontal canvas, filled it, and found out at export.
 *
 * Changing the default alone would not be enough. The aspect decides the whole
 * shape of the edit: the reframe, the text layout, what a picture-in-picture
 * means. It is worth one screen at the start, with **9:16 first**, and it is
 * the only thing on that screen that is not already reversible.
 */

import { ASPECTS, type AspectKey } from '../render/aspect'
import { emptyProject, type Project, type ProjectSettings } from '../timeline'

/**
 * The aspects offered, in the order they are reached for HERE.
 *
 * Not the order they are declared in: this app's first niche is short-form,
 * and a list that puts landscape first teaches that landscape is the normal
 * answer.
 */
export const NEW_PROJECT_ASPECTS: { key: AspectKey; hint: string }[] = [
  { key: '9:16', hint: 'Reels, TikTok, Shorts' },
  { key: '1:1', hint: 'Feed posts' },
  { key: '16:9', hint: 'YouTube, websites' }
]

/**
 * Frame rates worth offering.
 *
 * 30 first because it is what phones shoot and what every short-form platform
 * expects; 24 for anything meant to feel like film; 60 only where the motion is
 * the point, and marked as costing more because it does — twice the frames
 * through every filter in the graph.
 */
export const NEW_PROJECT_RATES: { fps: number; hint: string }[] = [
  { fps: 30, hint: 'What phones shoot' },
  { fps: 24, hint: 'Filmic' },
  { fps: 60, hint: 'Smooth — twice the render' }
]

export interface NewProjectChoice {
  name: string
  aspect: AspectKey
  fps: number
}

export const NEW_PROJECT_DEFAULT: NewProjectChoice = {
  name: 'Untitled',
  aspect: '9:16',
  fps: 30
}

/**
 * A project from the answers, with anything unanswered left at its default.
 *
 * Built on `emptyProject` rather than beside it, so a new project made this way
 * and one made any other way are the same object — including the tracks, the
 * caption defaults and the loudness target, none of which this screen asks
 * about because none of them is worth a question.
 */
export function projectFromChoice(choice: Partial<NewProjectChoice>): Project {
  const name = (choice.name ?? '').trim() || NEW_PROJECT_DEFAULT.name
  const aspect = NEW_PROJECT_ASPECTS.some((a) => a.key === choice.aspect)
    ? (choice.aspect as AspectKey)
    : NEW_PROJECT_DEFAULT.aspect
  const fps = NEW_PROJECT_RATES.some((r) => r.fps === choice.fps)
    ? (choice.fps as number)
    : NEW_PROJECT_DEFAULT.fps

  const base = emptyProject(name)
  const size = ASPECTS[aspect]
  const settings: ProjectSettings = {
    ...base.settings,
    width: size.width,
    height: size.height,
    fps
  }
  return { ...base, settings }
}
