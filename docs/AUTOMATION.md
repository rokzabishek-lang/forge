# Automation — toggles, triggers and placement

Five toggles were requested: captions, 3D props, stock b-roll, transitions, BGM + beat-sync.
They look like five features. They are one system with five configurations — the same
relationship the four products have to the Timeline IR (`research/architecture-plan-2026-09-11.md` §1).

---

## 1. The shape: a rule is four things

```
Rule = trigger × selector × placement × intensity
```

| Part | Question | Examples |
|---|---|---|
| **Trigger** | *When does this fire?* | a keyword in the transcript · a beat or drop · a silence · a scene change · a sentence start |
| **Selector** | *Which asset?* | this exact prop · search the stock API for a phrase · pick from a pool |
| **Placement** | *How does it appear?* | circle PiP · feathered edges · full-frame hold then fade · behind the subject |
| **Intensity** | *How often?* | at most N per minute · only above this confidence · only on downbeats |

Every toggle is a preset over those four fields:

| Toggle | Trigger | Selector | Placement | Intensity |
|---|---|---|---|---|
| Captions | every word | the transcript itself | caption style | always |
| 3D props | keyword match | prop whose tags match | pop-in overlay | props per minute |
| Stock b-roll | phrase / topic span | stock search | PiP or full-frame | cutaways per minute |
| Transitions | cut point | transition from a category | — | sparse (see §5) |
| SFX | beat, drop, or prop insert | SFX by tag | audio clip | hits per minute |
| BGM | whole timeline | track from pool or upload | ducked under speech | — |

**Everything a rule produces is an ordinary timeline clip.** Nothing is hidden, nothing is
baked in, nothing has a private representation. A prop inserted automatically is a clip the
user can drag, trim or delete like any other. That is what keeps automation from becoming a
black box.

---

## 2. 3D props — keyword triggering, and no AI needed

Your instinct is right, and it is *better* than using a model here: the transcript already
has word-level timestamps, so a keyword match gives a frame-accurate insertion point for
free. Deterministic, instant, debuggable, and it costs nothing.

The engineering is not the matching — it is avoiding false positives:

- **Word boundaries, not substrings.** "fired" must not trigger the *fire* prop, "brainstorm"
  probably should trigger *brain*. Match on tokens, with light stemming.
- **Tags, not filenames.** `fire_3d.png` should fire on fire / flame / burn / hot / lit /
  heat — a filename match alone catches a fraction of the real hits. Each prop needs a
  synonym list, authored once.
- **Cooldown.** The same prop three times in ten seconds looks broken. Enforce a minimum gap
  per prop and a global cap.
- **Intensity maps to a rate, not a probability.** "How many props per minute" is something a
  user can reason about; "40% chance" is not.

**Where a model *does* help:** resolving ambiguity ("did they mean fire the emotion or fire
the object?") and suggesting tags for new props. Both are optional refinements on a
deterministic base — the `baseline + diff` shape from `DIRECTOR.md` §3.

---

## 3. Stock b-roll — propose, don't apply

You asked whether the user should preview and select, or whether the AI should just place
it. **Do both, in that order: the AI proposes, the user confirms, and a default lands if
they never engage.**

```
1. Trigger finds a span that wants coverage
2. Selector fetches 4-6 candidates       ← AI writes the query
3. A strip of thumbnails appears on the clip
4. User picks one, or skips the slot entirely
5. If the user never touches it, candidate #1 is used
```

This is better than either extreme. Full auto is unpredictable and silently wrong; full
manual is slow and defeats the point. Propose-and-confirm keeps auto mode genuinely
automatic while never placing something the user cannot see coming.

**It also generates the dataset.** Which candidate a user picks — and which slots they skip
entirely — is a direct preference signal, exactly the training data `DIRECTOR.md` §5 says to
collect *before* considering a fine-tune. It arrives free, from normal use.

Manual search sits in the same panel and writes into the same slot, so "AI picked" and "I
picked" produce identical timeline state.

---

## 4. Placement — your five ideas are one object

Everything described — neat-edge PiP, circle PiP, dreamy transparent edges, full-frame hold
then fade back, manual opacity — is the same primitive with different values:

```ts
interface Placement {
  size: number            // fraction of frame: 0.3 = PiP, 0.99 = near-full
  position: 'center' | 'top-left' | ... | { x: number; y: number }
  shape: 'rect' | 'circle' | 'rounded'
  featherPx: number       // 0 = hard edge, high = the "magic" dreamy edge
  opacity: number
  enter: 'cut' | 'fade' | 'pop' | 'slide'
  exit: 'cut' | 'fade' | 'fall-back'
  holdMs: number          // full-frame hold before returning
}
```

Your ideas then become **presets**, and a new look is one object rather than new code:

| Preset | size | shape | feather | enter/exit |
|---|---|---|---|---|
| Neat PiP | 0.32 | rounded | 0 | pop / fade |
| Circle PiP | 0.30 | circle | 2 | pop / fade |
| Dream | 0.45 | circle | 60 | fade / fade |
| Takeover | 0.99 | rect | 0 | fade, hold 1.5s, fade back |

**Render tier per preset** (`research/architecture-plan-2026-09-11.md` §3b) falls out automatically:

- Hard-edged rect PiP, full-frame hold → **tier 1**, plain ffmpeg overlay
- Circle or feathered edges → needs an alpha mask → **tier 2**
- Behind-the-subject → **tier 3**, needs the matte bake

So the cheap looks stay cheap, and only the ones that genuinely need a compositor pay for
one.

---

## 5. Transitions — the honest guidance

You have 405 luma masks plus ~21 ffmpeg built-ins. Four things matter, in order:

**1. Most cuts should have no transition at all.** This is the single most important point.
Real editing is overwhelmingly hard cuts; a transition on every cut is the clearest amateur
tell there is. So the default rule must be *sparse* — transitions at section boundaries,
topic changes and musical drops, not between every clip. Make "none" the most common
outcome, and the ones you do use will land.

**2. Never show a flat list of 400.** Nobody chooses from 400. Curate into ~8-10 named
families with intent, each holding a handful of members:

> Dissolve · Whip · Zoom · Glitch · Light leak · Shape wipe · Film · Smooth

The user picks a *family* (or a vibe); the system picks a member, varying it so the same
wipe does not repeat every time.

**3. Let energy choose within a family.** The beat grid already knows whether a moment is a
drop or a lull. A drop gets the aggressive member, a quiet section gets the gentle one. This
is the same "LLM picks treatment, deterministic code picks timing" split as
`DIRECTOR.md` §11.1.

**4. Build a registry, not a special case per effect.** Each entry declares its id, family,
tier and parameters:

```ts
{ id: 'whip-left', family: 'whip', tier: 1, ffmpeg: 'slideleft', durationFrames: 8 }
{ id: 'ripple-04', family: 'smooth', tier: 2, mask: 'transitions/extra/barr_ripple_4.jpg' }
```

Built-ins are tier 1 and work today. Luma masks are tier 2 and arrive with the frame server.
**Same menu, same picker, different implementation** — so the UI never has to know which is
which, and a mask-based transition can be swapped for a cheaper built-in without touching
the timeline.

**Previews should be pre-rendered once and cached** — a short looping thumbnail per
transition, generated on first use. Live-rendering 400 previews in a browser will not be
pleasant.

### 5b. The 90% hard-cut rule does not apply to stills — corrected 2026-09-11

The research behind `DEFAULT_TRANSITION_RATE = 0.1` is about editing **footage**, where a
hard cut works because the subject's own movement carries continuity across it. Two
unrelated photographs have no such continuity. Applying the footage rate to the photo reel
produced two or three transitions across a whole song, and the result read as a contact
sheet rather than an edit.

So `planCuts` gained `transitionsOn: 'structural' | 'all'`:

- **`structural`** (default, for footage) — only drops, section changes and build-ends may
  carry a transition. The original rule, unchanged.
- **`all`** (used by the reel) — grid cuts are eligible too, at
  `DEFAULT_REEL_TRANSITION_RATE = 0.55`.

Two further corrections came out of the same bug:

1. **Rank-only selection clusters.** Sorting candidates by weight and taking the top N put
   every transition in the loudest passage and left the quiet one with none — backwards for
   stills, where an unbroken run of hard cuts is exactly what looks unfinished. Structural
   moments are still taken first; the remaining budget is then spread **evenly**.
2. **The treatment must vary, not just fire.** Three hardcoded IDs meant that even when
   transitions did fire they were always the same three. `pickTransition(tier, index,
   available)` walks tier-appropriate families and varies by index, so the 400-odd mask
   transitions participate without the planner knowing they exist.

The general lesson is worth keeping: **a finding is scoped to the medium it was measured
on.** Cut density being tempo-invariant survives the move from footage to stills. The
hard-cut ratio does not.

### 5c. Camera moves are the other half

Transition density was never the whole complaint — a reel of flat photographs looks like a
slideshow no matter what sits between the cuts. `Clip.motion` now carries twelve named
moves (centred push/pull, four drifting pushes, two drifting pulls, four pans) plus
`shake`, chosen per shot by energy tier: pans and pulls when quiet, pushes at peaks, a
held shake on a drop. Consecutive shots never repeat a move or its mirror, and selection
is deterministic in the shot index so rebuilding does not reshuffle an edit the user has
already watched.

The ceiling above this is parallax, which is a different technique rather than more
choreography — see `PARALLAX.md`.

### 5d. One photograph is a different problem — added 2026-09-12

A multi-photo reel cuts *between* pictures. With one picture there is nothing to cut to,
so every change has to be manufactured. Three sources, in `automation/onePhoto.ts`:

**Framing.** The photograph is treated as several shots, the way documentary editors have
cut archive stills for decades: wide, medium, close on the face, a detail. Two rules from
ordinary coverage practice keep it from looking broken.

- Shot sizes are proportions of the **figure**, not of the frame — a medium is waist-up, a
  close is head and shoulders. Cropping to a fraction of the picture instead lands the
  frame on whatever happens to be there, and on a standing subject that is their waist.
  This is why the bake now reports `subjectBox` and not just `subject: true`.
- Consecutive framings must **read as a cut**. The usual form of that rule is about size —
  under roughly 1.4× the frame twitches rather than cuts. Scale is only one way a frame
  changes, though: a same-size crop on a different part of the picture shows different
  content, which is a cut by any measure. `readsAsCut` accepts either.

That second half is not a refinement, it is what makes vertical work at all. Measured on a
4032×3024 phone photo at 1080×1920, the ladder has **two** rungs — the wide is already a
third of the photo's width, and the tightest crop the resolution supports is barely closer.
Scale alone gives a wide/medium ping-pong. Adding the shot that looks away gives four.

**Camera.** As §5c, inside the chosen crop, with less travel in a tight one — there is less
picture to move through before the move runs out of it.

Parallax is confined to the full-frame shots. Depth planes composite at the bake's own
resolution (`MAX_WORKING_SIZE`, 2048 on the long side), not the photograph's, so a crop in
source pixels would land somewhere else entirely. Framed shots take a flat move, which is
what a punch-in wants anyway.

**Text.** With one picture the words carry the rhythm, so the caption is the third source
of change rather than decoration on top of it. Cards land on **bars**, never beats: a title
that changes every beat flickers past unread at any tempo worth cutting to.

How much text fits on a card is set by reading speed, not word count — subtitle practice
puts comfortable reading at 15–17 characters a second, so the tempo decides the split. At
120 BPM a bar is 2s and about thirty characters fit; at 160 BPM it is 1.5s and twenty-four
do. The same caption therefore splits differently against different songs, which is the
point. A hard ceiling on card length applies regardless: a vertical reel is narrow, and
past about 48 characters the type has to shrink below what a phone can read.

---

## 6. Who is in control

For every rule, in auto mode: **the user, always — just asynchronously.**

- The rule writes ordinary clips onto the timeline
- Everything it did is visible, labelled, and individually revertable
- Nothing is applied that the user cannot see, move or delete

The AI is never the last word; it is a fast first draft. That is the same principle as the
director's baseline-plus-diff (`DIRECTOR.md` §3), and the reason an automated edit can be
trusted at all.
