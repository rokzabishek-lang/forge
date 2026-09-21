import type { Brief } from './schema'
import { MAX_SEGMENTS } from './schema'
import type { Menu } from './menu'

/**
 * What the model is told.
 *
 * Two parts, and the split matters for speed as much as for sense. The
 * SYSTEM prompt is the playbook — how an ad is built, what a headline is, how
 * to answer — and it is the same every time, so a server that caches the
 * prompt prefix (llama.cpp does) pays for it once (docs/DIRECTOR.md §10.6).
 * The USER prompt is this ad: the brief, the pictures, the cuts, the
 * families, as tables the model reads ids off.
 *
 * The playbook is the first version of docs/LLM.md's "distil the books": the
 * skeleton and the copy rules, written by hand, a few hundred tokens. It is a
 * prompt, not training, and it is where a better playbook goes when one is
 * measured to be better.
 */

export const PLAYBOOK = `You direct short ads and product demos for marketers. You are given the user's pictures and clips (SLOTS, in the order they placed them), the moments the music allows a cut (CUTS), and the transition families installed (FAMILIES). You answer with one JSON plan and nothing else.

THE SKELETON — an ad moves through these beats, in this order, skipping any it does not need:
- hook: stop the scroll in the first second — a bold claim, a question, the product in motion.
- problem: the pain the viewer has, in their own words.
- product: the hero shot. Name the product.
- proof: a result, a number, a testimonial.
- offer: price, discount, bundle — only if the brief gives one.
- cta: one imperative, what to do now.

RULES
- Pick from the menu by id. Never invent an id.
- Use the slots in the order given. You may skip slots; you may not reorder them.
- Each segment ends on a cut and starts where the previous one ended. Give the hook a short span and the product the longest.
- A video slot's length is given. Do not give it a segment longer than its footage.
- enter: most segments arrive with "cut". Use a family only on a drop, a section change, or to reveal the product. The first segment always enters with "cut".
- headline: six words or fewer, concrete nouns, one idea, or an empty string for no card. The cta headline is an imperative. No exclamation marks unless the tone is energetic.
- punch_word: copy ONE word of the headline exactly — the word that hits. Empty if none.
- why: a few words on why this picture, here.
- reasoning comes first: one or two sentences on what the ad is and how it moves.`

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** The two prompts for one plan. */
export function spinePrompt(brief: Brief, menu: Menu): { system: string; user: string } {
  const end = menu.cuts[menu.cuts.length - 1]
  const lines: string[] = []

  lines.push('BRIEF')
  lines.push(`product: ${brief.product}`)
  if (brief.benefit) lines.push(`benefit: ${brief.benefit}`)
  if (brief.audience) lines.push(`audience: ${brief.audience}`)
  lines.push(`tone: ${brief.tone}`)
  if (brief.cta) lines.push(`call to action: ${brief.cta}`)
  lines.push(`language for all copy: ${brief.language}`)
  lines.push(
    `target length: ${brief.seconds.toFixed(1)} s — the ad ends at ${end.id} (${seconds(end.ms)})${
      end.landsOn ? `, which is a ${end.landsOn}` : ''
    }`
  )

  lines.push('')
  lines.push("SLOTS (in the user's order — skip any, reorder none)")
  for (const s of menu.slots) {
    const parts = [s.id, s.kind === 'video' ? `video ${s.seconds?.toFixed(1)} s` : 'image', `"${s.label}"`]
    if (s.note) parts.push(`— ${s.note}`)
    if (s.speech) parts.push(`— says: "${s.speech}"`)
    lines.push(parts.join('  '))
  }

  lines.push('')
  lines.push('CUTS (id, time, what it is, energy 0-3)')
  for (const c of menu.cuts) {
    const what = c.reason === 'end' && c.landsOn ? `end (${c.landsOn})` : c.reason
    lines.push(`${c.id}  ${seconds(c.ms)}  ${what}  ${c.energy}`)
  }

  lines.push('')
  lines.push('FAMILIES for enter')
  for (const f of menu.families) lines.push(`${f.id} — ${f.intent}`)

  lines.push('')
  lines.push('Answer with the JSON plan.')

  return { system: PLAYBOOK, user: lines.join('\n') }
}

/**
 * Room for the answer, from the size of the menu.
 *
 * One segment is ~75–95 tokens — digits and JSON punctuation tokenise one
 * piece at a time — plus ~200 for the wrapper, the pace and the reasoning.
 * A flat cap could not hold the schema's own `maxItems`: at 450 a
 * twelve-slot plan was cut off around segment five and fell to the baseline
 * every time, looking like a model failure.
 */
export function maxTokensFor(menu: Pick<Menu, 'slots'>): number {
  return 200 + 95 * Math.min(menu.slots.length, MAX_SEGMENTS)
}
