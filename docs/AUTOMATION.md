# Automation — toggles, triggers and placement

Five toggles were requested: captions, 3D props, stock b-roll, transitions, BGM + beat-sync.
They look like five features. They are one system with five configurations — the same
relationship the four products have to the Timeline IR (`PLAN.md` §1).

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

**Render tier per preset** (`PLAN.md` §3b) falls out automatically:

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

---

## 6. Who is in control

For every rule, in auto mode: **the user, always — just asynchronously.**

- The rule writes ordinary clips onto the timeline
- Everything it did is visible, labelled, and individually revertable
- Nothing is applied that the user cannot see, move or delete

The AI is never the last word; it is a fast first draft. That is the same principle as the
director's baseline-plus-diff (`DIRECTOR.md` §3), and the reason an automated edit can be
trusted at all.
