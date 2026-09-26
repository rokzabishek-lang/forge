import type { Problem } from './conforms'
import type { Composed } from './compose'
import type { Grid } from './rhythm'
import type { Brief } from './schema'
import { movesOf, type Menu2 } from './schema2'

/**
 * Coherence — the ad reads as one piece (docs/PLAN.md §5.4).
 *
 * **One intensity per ad.** The recipe's default, nudged by the brief's tone,
 * sets the type size, the look's strength, the camera moves' amplitude and —
 * recorded for C3 and C4 — the moments' amplitude and the sound levels,
 * TOGETHER, so nothing is turned up alone.
 *
 * **A clash table**, checked after layout and repaired with a note. Most of
 * the table the rhythm engine already guarantees by construction (moments a
 * bar apart and never on a transition or the treatment's cut, hits a bar
 * apart, whooshes a bar apart) and the validator the rest (a move, style or
 * animation outside the recipe; a ramp on a clip that speaks). What is left
 * needs something neither sees on its own: the plan's speeds against the
 * engine's transitions, one sound against another of a different kind, a move
 * against the one before it, and a look against a family or a style.
 */

/** The tone's nudge to the recipe's intensity. */
const TONE_NUDGE: Record<Brief['tone'], number> = { urgent: 0.15, energetic: 0.15, playful: 0, calm: -0.15, premium: -0.15 }

export function intensityFor(recipe: Composed['recipe'], tone: Brief['tone']): number {
  return Math.max(0, Math.min(1, recipe.intensity + (TONE_NUDGE[tone] ?? 0)))
}

/** Looks a glitch would break. */
const WARM_LOOKS = new Set(['warm-film', 'golden-hour'])
/** Type that is never a wedding's. */
const LOUD_STYLE = /^(chrome|flames|neon-)/
const GLITCH_STYLE = /^glitch/

export interface Cohered extends Composed {
  /** 0..1 — the one dial the type, the look, the moves and (C3, C4) the moments and sounds read. */
  intensity: number
}

export function cohere(composed: Composed, grid: Grid, brief: Pick<Brief, 'tone'>, menu: Pick<Menu2, 'slots'>): Cohered {
  const { recipe, layout } = composed
  const kindOf = new Map(menu.slots.map((s) => [s.id, s.kind]))
  const problems: Problem[] = [...composed.problems]
  const plan = { ...composed.plan, shots: composed.plan.shots.map((s) => ({ ...s })) }
  const bar = grid.beatFrames * 4
  const wedding = recipe.id === 'wedding-highlight'
  const warm = WARM_LOOKS.has(recipe.look)

  /* The type against the recipe and its look. */
  if ((wedding && LOUD_STYLE.test(plan.style)) || (warm && GLITCH_STYLE.test(plan.style))) {
    const style = recipe.type.styles.find((s) => !LOUD_STYLE.test(s) && !GLITCH_STYLE.test(s)) ?? recipe.type.styles[0]
    problems.push({ path: '$.style', message: `"${plan.style}" clashes with ${wedding ? 'a wedding' : `the ${recipe.look} look`} — ${style}` })
    plan.style = style
  }

  /* Transitions: no glitch over a warm look; no whip beside a slowed or ramped shot. */
  const slowed = (i: number): boolean => plan.shots[i]?.speed === 'slow' || plan.shots[i]?.speed === 'ramp'
  const calmFamily = recipe.transitions.families.find((f) => f !== 'glitch')
  const cutAt = new Set<number>()
  const transitions = layout.transitions.flatMap((t) => {
    if (warm && t.family === 'glitch') {
      problems.push({ path: `$.transitions[${t.shot}]`, message: `a glitch over the ${recipe.look} look — ${calmFamily ?? 'a cut'}` })
      return calmFamily ? [{ ...t, family: calmFamily }] : []
    }
    if (t.family === 'whip' && (slowed(t.shot) || slowed(t.shot - 1))) {
      problems.push({ path: `$.transitions[${t.shot}]`, message: `a whip beside a ${slowed(t.shot) ? plan.shots[t.shot].speed : plan.shots[t.shot - 1].speed} shot fights it — a cut` })
      cutAt.add(layout.shots[t.shot].startFrame)
      return []
    }
    return [t]
  })

  /* Sounds: a whip that became a cut takes its whoosh with it; a hit and a whoosh within a bar, the quieter cut's goes. */
  const percussive = (e: string): boolean => e === 'hit' || e === 'sub' || e === 'whoosh'
  let sounds = layout.sounds.filter((s) => !(s.event === 'whoosh' && cutAt.has(s.frame)))
  const drop = new Set<number>()
  sounds.forEach((a, i) => {
    sounds.forEach((b, j) => {
      if (j <= i || drop.has(i) || drop.has(j)) return
      if (!percussive(a.event) || !percussive(b.event) || a.event === b.event) return
      if ((a.event === 'hit' || a.event === 'sub') && (b.event === 'hit' || b.event === 'sub')) return
      if (Math.abs(a.frame - b.frame) >= bar) return
      // The quieter cut's event goes; on a tie, the whoosh — the hit is the one the music asked for.
      const ea = grid.energyAt(a.frame)
      const eb = grid.energyAt(b.frame)
      const loser = ea === eb ? (a.event === 'whoosh' ? i : j) : ea < eb ? i : j
      drop.add(loser)
      problems.push({ path: '$.sounds', message: `a ${sounds[loser].event} within a bar of a ${sounds[loser === i ? j : i].event} — dropped` })
    })
  })
  sounds = sounds.filter((_, i) => !drop.has(i))

  /* Moves: the same move on two stills in a row reads as a template — the second takes the recipe's next. */
  const moves = movesOf(recipe).filter((m) => m !== 'hold')
  for (let i = 1; i < plan.shots.length; i++) {
    const prev = plan.shots[i - 1]
    const shot = plan.shots[i]
    const heroish = shot.slot === plan.hero || prev.slot === plan.hero
    const stills = kindOf.get(shot.slot) === 'image' && kindOf.get(prev.slot) === 'image'
    if (heroish || !stills || shot.move === 'hold' || shot.move !== prev.move || moves.length < 2) continue
    const next = moves[(moves.indexOf(shot.move) + 1) % moves.length]
    problems.push({ path: `$.shots[${i}].move`, message: `${shot.slot} would repeat "${shot.move}" — ${next}` })
    shot.move = next
  }

  return {
    ...composed,
    plan,
    layout: { ...layout, transitions, sounds },
    problems,
    intensity: intensityFor(recipe, brief.tone)
  }
}
