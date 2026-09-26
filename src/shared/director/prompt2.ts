import type { Brief } from './schema'
import { MAX_SEGMENTS } from './schema'
import { languageLine } from './prompt'
import { lookLine } from './look'
import { movesOf, type Menu2 } from './schema2'

/**
 * What the model is told for `spine@2` (docs/PLAN.md §5.2).
 *
 * The system prompt is the same for every ad, so a server caches it once; the
 * user prompt is this ad — the brief, the music in a sentence, the recipes on
 * offer with their roles, moves and styles, the hero candidates, and the
 * slots with what the eyes saw. There is no table of cuts: the model does not
 * time anything any more.
 */

export const PLAYBOOK2 = `You direct short ads and highlight films. You are given the user's pictures and clips (SLOTS, in the order they placed them, with what each one shows), the RECIPES you may direct with, the HERO pictures you may build the ad around, and the music. You answer with one JSON plan and nothing else.

HOW IT WORKS — you choose, the app times. You pick the recipe, the hero, the text style and which shots to use and how much each matters. The app cuts every shot on the beat, holds the hero longest, shortens the shots towards the peak when the recipe says so, and ends with black and an end card. Do not try to time anything.

RULES
- recipe: the one whose "for" fits the brief and the pictures. A wedding is never a sales ad.
- hero: one id from HERO — the picture the whole ad is built around.
- style and animation: from the chosen recipe's lists; one each for the whole ad.
- shots: in slot order; skip a picture that does not belong; the hero must be one of them. Use about as many shots as the music holds.
- role: from the chosen recipe's roles, in their order. The first shot is the hook.
- weight: hold for the hero and for faces that matter, quick for a passing detail, normal otherwise.
- move: from the chosen recipe's moves; hold keeps the picture still. speed: normal for stills; slow or ramp only for a clip.
- headline: six words or fewer, concrete, or an empty string — most shots need none. A wedding's lines are names, a place, a feeling, never a sales line. The last line is the call to action when the brief has one.
- The hook's headline names the product or the brand — a wedding, the couple's names — so it is read in the first two seconds, before anyone scrolls away.
- punch_word: copy ONE word of the headline exactly — the word that hits — or empty.
- A slot's "shows" is what is really in the picture: write about that. A slot "measured soft", "dark" or "blown" is never the hook or the hero.
- language: every headline and punch_word is in the brief's copy language, in that language's own script — never English when another language is asked, never transliterated into Latin letters. Brand and product names stay exactly as the brief writes them. reasoning and why may be in English.
- reasoning comes first: one or two sentences on what the ad is and which recipe fits.`

const s1 = (seconds: number): string => `${seconds.toFixed(1)} s`

export function spine2Prompt(brief: Brief, menu: Menu2): { system: string; user: string } {
  const lines: string[] = []
  lines.push('BRIEF')
  lines.push(`product: ${brief.product}`)
  if (brief.benefit) lines.push(`benefit: ${brief.benefit}`)
  if (brief.audience) lines.push(`audience: ${brief.audience}`)
  lines.push(`tone: ${brief.tone}`)
  if (brief.cta) lines.push(`call to action: ${brief.cta}`)
  lines.push(`language for all copy: ${brief.language}`)

  lines.push('')
  const drops = menu.drops.length > 0 ? `, a drop at ${menu.drops.map(s1).join(' and ')}` : ''
  lines.push(`MUSIC: ${s1(menu.seconds)} at ${Math.round(menu.bpm)} BPM${drops}. It holds about ${menu.holds.min} to ${menu.holds.max} shots.`)

  lines.push('')
  lines.push('RECIPES')
  for (const r of menu.recipes) {
    lines.push(`${r.id} — ${r.name}: ${r.intent} For: ${r.forKind}.`)
    lines.push(`   roles: ${r.roles.join(', ')} · moves: ${movesOf(r).join(', ')} · styles: ${r.type.styles.join(', ')} · animations: ${r.type.animations.join(', ')}`)
  }

  lines.push('')
  lines.push(`HERO (choose one): ${menu.heroCandidates.join(', ')}`)

  lines.push('')
  lines.push("SLOTS (in the user's order — skip any, reorder none)")
  for (const s of menu.slots) {
    const parts = [s.id, s.kind === 'video' ? `video ${s.seconds?.toFixed(1)} s` : 'image', `"${s.label}"`]
    if (s.note) parts.push(`— ${s.note}`)
    if (s.speech) parts.push(`— says: "${s.speech}"`)
    if (s.look) parts.push(`— shows: ${lookLine(s.look)}`)
    if (s.flags && s.flags.length > 0) parts.push(`— measured ${s.flags.join(', ')}`)
    lines.push(parts.join('  '))
  }

  lines.push('')
  const language = languageLine(brief.language)
  if (language) lines.push(language)
  lines.push('Answer with the JSON plan.')
  return { system: PLAYBOOK2, user: lines.join('\n') }
}

/**
 * Room for the answer: ~110 tokens a shot (eight fields, two of them free
 * text, the why up to 100 characters) and ~250 for the wrapper and the
 * reasoning. Re-measured for this shape rather than carried over from
 * `spine@1` — a stale cap truncated every long plan once (docs/LLM.md).
 */
export function maxTokensFor2(menu: Pick<Menu2, 'slots'>): number {
  return 250 + 110 * Math.min(menu.slots.length, MAX_SEGMENTS)
}
