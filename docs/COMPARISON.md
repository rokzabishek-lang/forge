# Forge against the market — 22 September 2026

An honest, evidence-backed comparison of Forge with the editors and AI ad
tools a marketer would otherwise use. Written to answer one question: **is
this a real NLE yet, and what real things are missing?**

**How it was made, so the certainty is visible.** Forge's side comes from a
code audit: six readers, one per area, each claim about something *missing*
then checked by a second agent that read the code again with a default of
"it exists until proven otherwise" (42 agents; 36 gaps confirmed, 0 refuted).
Every Forge claim below has a `file:line` behind it in the audit; the
important ones are cited here. The market side comes from one researcher per
product reading vendor documentation first, with a checker per product on
the backend and pricing claims (16 agents). Marks on market claims:

- **✓** — on the vendor's own pages
- **~** — credible reporting, not vendor-documented
- **?** — inference, labelled as such
- **not public** — the vendor has not said, and nobody should guess

Prices are US list, September 2026, and vary by region and promotion.

---

## 0. The verdict, in one paragraph

Forge has a **real NLE underneath** — a frame-accurate multi-track timeline
with transactional undo, cross-track dragging, keyframes whose preview curve
is the export curve, real pixel masks, colour parity with the render at
Resolve level, and an audio render chain (equal-power crossfades, correct
`amix`, LUFS normalisation, sidechain ducking) that is better than CapCut's.
What it does **not** have is the editing *surface* a CapCut user touches in
the first hour: multi-select, copy/paste/duplicate, ripple delete, a timeline
that follows the playhead, transitions and the audio mix **shown in the
preview**, relink, autosave, a File menu. Two of the gaps are outright bugs:
split and trim ignore clip speed. So, honestly: **a well-engineered render
core with an incomplete editor on top** — not yet a place to *finish* a video,
but a short list away from being one, and already the only tool on this list
that is local, unmetered, and whose automation is auditable clip by clip.

---

## 1. The products

| | Forge | CapCut desktop | Adobe Premiere | DaVinci Resolve | Final Cut Pro | Descript | Opus Clip | Captions (Mirage) | AI ad-makers |
|---|---|---|---|---|---|---|---|---|---|
| **what it is** | local Electron NLE + automation for short-form ads | freemium native NLE + template marketplace + AI layer | professional NLE | professional post suite (edit, colour, Fairlight, Fusion) | professional Mac NLE, magnetic timeline | cloud transcript-first editor + agent | cloud long-to-short clipper | cloud avatar/UGC ad generator + light editor | Creatify, invideo, VEED, Predis, Pencil — cloud brief-to-ad |
| **version** | `c2f68a5` | 9.3.0 (1 Sep 2026) ~ | 26.5 (10 Sep 2026) ✓ | 21.1 (9 Sep 2026) ✓ | 12.3 (30 Jun 2026) ✓ | continuous | continuous | continuous | continuous |
| **platforms** | macOS, Windows | macOS, Windows, mobile, web | macOS, Windows (incl. ARM) | macOS (Apple silicon only in 21), Windows, Linux | macOS, iPad | macOS, Windows, web | web, iOS, Android | iOS lead, web, macOS wrapper, Android Lite | web |
| **price** | free, open source | Free; Pro $19.99/mo ✓ (Standard ~$9.99 ~) | ~$22.99/mo annual ~; CC Pro ~$69.99 with 4,000 credits ✓ | Free; Studio $295 once ✓ | $299.99 once, or Creator Studio $12.99/mo ✓ | Free–$65/mo, media minutes + AI credits ✓ | Free–$29/mo, 1 credit per source minute ✓ | Free; Basic $9.99; Max $24.99; Frontier $69.99+ ✓ | Creatify $0–99; invideo $20–100/seat; Predis, VEED, Pencil credit-metered ✓ |
| **where the AI runs** | **on your machine** (Ollama / LM Studio / sidecar); no per-use cost | hybrid; content pre-uploaded per privacy policy ✓ | hybrid: on-device ASR/masks, cloud generative (credits) ✓ | **local**, unmetered (Studio) ✓ | **local** (one model download) ✓ | cloud, metered ✓ | cloud, metered ✓ | cloud, metered ✓ | cloud, metered ✓ |
| **target** | marketers making ads / product demos; meme creators | social creators, small brands, e-commerce | editors by trade | editors, colourists, audio post | Mac editors, creators | podcasters, talking-head video | people with long recordings | phone-first solo marketers | performance marketers at volume |

---

## 2. Feature by feature

Legend: **✓** built and wired end to end · **partial** exists in a limited
form (said how) · **✗** absent · **bug** present but wrong.

### 2.1 Editing on the timeline

| feature | Forge | CapCut | Premiere | Resolve | Final Cut |
|---|---|---|---|---|---|
| multi-track video + audio | ✓ up to 12 tracks | ✓ unlimited | ✓ | ✓ | ✓ (trackless, connected clips) |
| **multi-select** (shift / marquee) | **✗** — one clip, `selectedClipId: string \| null` (`store.ts:302`) | ✓ | ✓ | ✓ | ✓ |
| **copy / paste / duplicate** | **✗** — no clipboard, no action, no key (`App.tsx:151-198` is the whole keymap) | ✓ (duplicate on the clip) | ✓ | ✓ | ✓ |
| **ripple delete / close gap** | **✗** — delete leaves a hole (`store.ts:923-926`) | ✓ Ctrl+Shift+E; delete closes by default | ✓ lift and extract | ✓ | ✓ ripple is the default trim |
| split at playhead | ✓ `S` | ✓ | ✓ | ✓ | ✓ |
| **split / trim on a retimed clip** | **bug** — `splitClip` and `trimStart`/`trimEnd` ignore `speed`; at 2× the second half replays footage (`timeline.ts:869-907` vs `sourceFrameFor` :763) | ✓ | ✓ | ✓ | ✓ |
| trim by drag | ✓ | ✓ | ✓ | ✓ | ✓ |
| slip / slide / roll | ✗ | partial (drag-first, no trim modes) | ✓ tools + Trim Monitor | ✓ | ✓ |
| markers | ✗ | ✓ | ✓ with comments, colours | ✓ | ✓ incl. to-do, chapter |
| in / out points, range | ✗ | ✓ | ✓ three/four-point | ✓ | ✓ |
| link / unlink / detach audio | **✗** — a video clip's audio cannot be separated; hiding a video track also drops its sound (`plan.ts:583`) | ✓ Separate audio | ✓ | ✓ | ✓ detach / expand |
| nesting / compound clips | ✗ | ✓ compound | ✓ nest, Productions | ✓ | ✓ compound, secondary storylines |
| speed | ✓ constant, pitch-correct, ripples neighbours; optical-flow slow toggle with its 41× cost stated | ✓ curves / ramps | ✓ time remapping, ramps | ✓ ramps, Speed Warp | ✓ ramps, Smooth Slo-Mo |
| snapping | ✓ pixel-constant to edges, playhead, zero; cannot be toggled | ✓ | ✓ | ✓ | ✓ |
| cross-track drag (time + layer in one gesture) | ✓ refuses wrong-kind/locked lanes | partial | ✓ | ✓ | n/a |
| **timeline follows the playhead** | **✗** — `scrollLeft` is only ever read (`Timeline.tsx:186`) | ✓ | ✓ page / smooth | ✓ | ✓ |
| zoom to fit | ✗ | ✓ Shift+Z | ✓ | ✓ | ✓ |
| undo | ✓ 100 deep, a drag is one step, a Director plan is one step | ✓ | ✓ | ✓ | ✓ |
| keyboard model | Space, S, arrows, Home/End, ⌘Z/⇧⌘Z, Delete, ⌘S/⌘O — **no shortcut reference, no menu** | ~50 hotkeys, in-app reference, remappable ✓ | full editor with visual keyboard | full, customisable | full command editor |
| right-click menu | ✗ | ✓ | ✓ | ✓ | ✓ |

**Forge strengths the others do not share:** the transition drop snaps to the
nearest cut and *says why* when there is none (`Timeline.tsx:118-138`); a
clip already overlapping others is treated as a layer, not shoved along the
track (`store.ts:950-953`); the waveform on a clip shows the trimmed,
speed-corrected window of the source (`ClipWaveform.tsx:85-87`).

### 2.2 Preview and playback

| feature | Forge | CapCut | Premiere | Resolve | Final Cut |
|---|---|---|---|---|---|
| clock | timeline-owned, cannot drift; slow composite drops frames rather than slowing the edit (`clock.ts:57-92`) | native GPU preview | Mercury Playback Engine | GPU realtime engine | Metal, background render |
| all layers composited live | ✓ every visible track, adjustment layers in order | ✓ | ✓ | ✓ | ✓ |
| **transitions shown in preview** | **✗** — every one plays as a cross-dissolve; `transitionIn.id` is never read (`Preview.tsx:817-826`) | ✓ | ✓ (render bar on heavy ones) | ✓ | ✓ |
| colour shown as it exports | ✓ ffmpeg's `eq` maths in BT.709 on the GPU, same curve table, trilinear .cube (`grade.ts:32-101`) | ✓ | ✓ | ✓ (its flagship) | ✓ |
| masks shown as pixel ops | ✓ (`maskPreview.ts`) | ✓ | ✓ | ✓ | ✓ |
| text and captions live | ✓ same painter as the export; typing updates the frame | ✓ | partial (render bar) | ✓ | ✓ |
| keyframes / speed / camera moves live | ✓ same `valueAt` as the export | ✓ | ✓ | ✓ | ✓ |
| **audio mix heard in preview** | **✗** — only flat `clip.volume`; envelope, fades, crossfade and ducking are render-only (`Preview.tsx:605, 671`) | ✓ | ✓ | ✓ | ✓ |
| **audio while scrubbing** | **✗** — elements pause when not playing (`Preview.tsx:696-701`) | ✓ | ✓ | ✓ | ✓ |
| proxy / playback quality control | ✗ — grades run at full source resolution per frame (`grade.ts:409-447`) | ✓ 720p/540p proxies ~ | ✓ ½ ¼ ⅛ + proxies | ✓ proxies, optimised media, cache | ✓ proxy, Better Performance |
| scopes | ✗ | ✗ | ✓ Lumetri | ✓ full set | ✓ |
| missing media shown | **✗** — black frame, no badge, no relink (`Preview.tsx:1174`) | ✓ badge | ✓ Media Offline | ✓ red card + relink | ✓ Missing File |
| source / split / output view | ✓ draggable divider, two independently framed viewports | ✗ | partial | partial | partial |
| fullscreen | ✗ | ✓ | ✓ | ✓ | ✓ |

### 2.3 Audio

| feature | Forge | CapCut | Premiere | Resolve | Final Cut |
|---|---|---|---|---|---|
| per-clip level | partial — **0–100 % only, clamped in three places**; no boost above unity (`store.ts:3411`, `Inspector.tsx:768`, `keyframes.ts:57`) | ✓ to 200 % | ✓ +6 dB rubber band, +96 dB gain | ✓ +12 dB | ✓ +12 dB |
| volume envelope on the clip | ✓ drawn, keyframed | ✓ | ✓ | ✓ | ✓ |
| fades | ✓ grips both ends, `qsin` curve chosen by measurement | ✓ | ✓ | ✓ | ✓ |
| crossfade | ✓ derived from overlap, equal power — cannot be forgotten | ✓ | manual audio transition | ✓ | ✓ |
| ducking under speech | ✓ render (`sidechaincompress`) — **not heard in preview** | ✓ in automated flows | ✓ Essential Sound, keyframed | ✓ | partial |
| mute / **solo** per track | mute on audio tracks; **no solo**; video tracks have no mute | ✓ | ✓ | ✓ | ✓ |
| **level meters / clipping** | **✗** none; no Web Audio graph in the renderer | ✓ level bar | ✓ | ✓ | ✓ |
| **detach audio from video** | **✗** | ✓ | ✓ | ✓ | ✓ |
| **voice-over recording** | **✗** — no mic capture anywhere | ✓ | ✓ | ✓ | ✓ |
| loudness normalisation | ✓ LUFS presets on the Output panel, measured after ducking and music | ✗ | Loudness Radar (manual) | ✓ | partial |
| stems / vocal isolation | ✓ Demucs (opt-in) with mid/side fallback | ✓ Pro | Enhance Speech | ✓ Voice Isolation, Dialogue Separator | ✓ Voice Isolation |
| SFX library | ✓ auditioned and trimmed before placing | ✓ | ✓ Adobe Stock | ✗ (third-party) | small bundled set |
| licensed music library | ✗ | ✓ free + Pro | ✓ Stock | ✗ | small |
| text-to-speech | ✓ engine wired (Kokoro local, or any OpenAI-shaped endpoint); narration UI marked *soon* | ✓ | ✗ (not documented) | ✓ Speech Generator w/ cloning (Studio, 21) | ✗ |
| sample-rate safety | ✓ every clip conformed to 48 kHz before the mix | ✓ | ✓ | ✓ | ✓ |
| `amix` gain correction | ✓ measured and documented (`plan.ts:536-572`) | n/a | n/a | n/a | n/a |

### 2.4 Media in, project, video out

| feature | Forge | CapCut | Premiere | Resolve | Final Cut |
|---|---|---|---|---|---|
| import formats | what the bundled ffprobe accepts; rotation and HEIC unverified | broad ~ | very broad, camera RAW | very broad, camera RAW | Apple codecs + broad |
| import from a link | ✓ yt-dlp, clip a range before download, queued like an export | web ingest from Drive/Dropbox ✓ | ✗ | ✗ | ✗ |
| **drop a file anywhere** | **✗** — only the Media grid handles external drops; the timeline and preview accept only Forge's own drag type (`Timeline.tsx:379`, `Preview.tsx:1491`) | ✓ | ✓ | ✓ | ✓ |
| media pool management | **✗** — read-only grid: no delete, rename, search, sort, bins (`MediaPool.tsx:144-216`) | ✓ delete, multi-select | ✓ bins, search | ✓ smart bins, metadata | ✓ keywords, ratings |
| thumbnails | live `<video>` elements, no hover-scrub | ✓ | ✓ GPU | ✓ | ✓ |
| **relink missing media** | **✗** — absolute paths, no existence check, project opens onto black (`project.ts:126-133`) | ✓ badge | ✓ Link Media | ✓ Relink Clips | ✓ Relink Files |
| **autosave / crash recovery** | **✗** — only ⌘S writes; no close guard even when dirty (`index.ts:126-133`) | ✓ drafts autosave | ✓ 15-min autosave + cloud | ✓ live save, database | ✓ continuous |
| **File menu, Save As, Recent** | **✗** — no Electron `Menu`; Save/Open are undiscoverable hotkeys; `newProject` never called | ✓ project home | ✓ | ✓ | ✓ |
| project file | versioned JSON with migration hook; unknown fields survive | undocumented JSON drafts ~ | binary, one-way | database | library bundle |
| **export choices** | **✓ mostly (B2)** — H.264 / H.265 / ProRes and hardware encoders, offered only when a test encode works here; CRF presets or a bitrate; AAC 128–256k; mp4 or mov; 720p / 1080p / 4K; in–out range; frame rate 24/25/30/50/60, convertible with work in the project (`render/encode.ts`, `render/exportShape.ts`, `project/frameRate.ts`, `components/ExportSettings.tsx`) | res 480p–4K/8K ✓~, fps, bitrate, format | Media Encoder presets | Deliver page, custom presets | Share presets + Compressor |
| **project frame rate** | **✗ fixed at 30** — nothing writes `settings.fps` (`timeline.ts:656`) | ✓ | ✓ | ✓ | ✓ |
| hardware encoding | ✗ software libx264 | ✓ toggle ~ | ✓ NVENC/VCN/QSV/VideoToolbox | ✓ | ✓ media engine |
| background export queue with cancel | ✓ — and a cancel leaves no truncated file behind (`run.ts:130-157`) | modal ~ | ✓ Media Encoder | ✓ render queue | ✓ background |
| publish to social | ✗ | ✓ | ✓ | ✗ | ✓ YouTube/Vimeo |
| installers | unsigned, no auto-update, placeholder name | signed | signed | signed | App Store |

### 2.5 Effects, colour, text, keyframes

| feature | Forge | CapCut | Premiere | Resolve | Final Cut |
|---|---|---|---|---|---|
| colour controls | brightness / contrast / saturation + RGB & master curves + 3D LUT with intensity, in the Resolve order | wheels, HSL, auto-adjust, filters ✓ | Lumetri (full) | node grading (flagship) | wheels, curves, LUTs |
| **temperature / tint / exposure** | **✗** — `ColorAdjust` has three sliders (`timeline.ts:134-156`) | ✓ | ✓ | ✓ | ✓ |
| adjustment layer | ✓ grades everything beneath it | ✗ | ✓ | ✓ | ✗ (compound) |
| masks | ✓ rect / ellipse / line, feather, invert, **and a verb**: blur inside, grade inside, reveal | reveal shapes ✓ | ✓ with tracking | ✓ power windows + tracking | ✓ |
| **mask tracking / keyframing** | **✗** — shape is static for the clip (`keyframes.ts:33`) | ✓ Pro | ✓ | ✓ | ✓ |
| **chroma key** | **✗** — no keyer in the render plan | ✓ free | ✓ Ultra Key | ✓ 3D Keyer | ✓ |
| stabilisation | ✗ | ✓ | ✓ Warp Stabilizer | ✓ | ✓ |
| keyframes | ✓ zoom, rotation, opacity, volume + motion path; linear/smooth/hold; freehand curve sketching | ✓ + graphs | ✓ | ✓ Bezier, loop, ping-pong | ✓ |
| camera moves on stills | **built but unreachable by hand** — 12 Ken Burns moves, decaying shake, depth parallax; only automations set `motion` (`timeline.ts:521-568`) | ✓ | ✓ | ✓ | ✓ |
| text styles | ✓ 24+ (gradient, glow, metallic, boxed) × 80+ fonts + system fonts × 9 arrivals — three independent axes | ✓ presets | Essential Graphics / .mogrt | Text+ (Fusion) | titles, Motion |
| captions | ✓ auto, 45 styles, spoken word highlighted; live in preview | ✓ | ✓ single-word style (26.3) | ✓ Animated Subtitles (Studio) | ✓ |
| **edit a transcript / caption** | **✗** — read-only after ASR (`TranscriptPanel.tsx:61-83`) | ✓ | ✓ | ✓ | ✓ |
| stickers | ✓ 636 keyed video cut-outs with sound, colour+matte pairs, maskable | ✓ large library | via Stock | ✗ | ✗ |
| transitions | ✓ 8 built-in + 412 luma-mask wipes tagged by what they do; between layered clips too — **not previewed** | ✓ large, Pro-gated | ✓ 90+ GPU | ✓ | ✓ |
| PiP | ✓ shapes, positions, rounded edges | ✓ | ✓ | ✓ | ✓ |
| blend modes | not verified | ✓ | ✓ | ✓ | ✓ |
| grid split / strip flashes / filmstrip / one-photo framing / newspaper clippings / card ring | ✓ — **unique**, each an ordinary reversible clip | ✗ | ✗ | ✗ | ✗ |
| depth parallax on stills | ✓ Depth Anything V2 planes, local | ✗ | ✗ | ✓ Depth Map | ✗ |
| text behind subject (stills) | ✓ subject cutout, local | ✓ (video, cloud ~) | ✓ Object Mask | ✓ Magic Mask | ✓ Magnetic Mask |
| honest about the unbuilt | ✓ Paint tool greyed with "stills only, and a long way off" | — | — | — | — |

### 2.6 AI and automation

| feature | Forge | CapCut | Premiere | Resolve (Studio) | Final Cut | Descript | Opus Clip | Captions | ad-makers |
|---|---|---|---|---|---|---|---|---|---|
| auto captions | ✓ local faster-whisper `small`; Indic via Whisper | ✓ cloud ✓ | ✓ on-device Speechmatics ✓ | ✓ local | ✓ Apple model, **US English only** ✓ | ✓ 26 Latin-alphabet languages ✓ | ✓ | ✓ 100+ styles | ✓ |
| beat detection / beat-sync cut | ✓ local librosa; reel, grid, strips cut on it | ✓ AutoCut | ✗ (Remix retimes music) | ✗ | ✓ Beat Detection (12.0) | ✗ | ✗ | ✗ | template-timed |
| auto reframe 16:9 → 9:16 | partial — geometric crop solver + subject box on stills; **no video subject tracking** | ✓ subject tracking | ✓ Auto Reframe | ✓ Smart Reframe | ✓ Smart Conform | ✗ | ✓ active-speaker | ✗ | ✓ |
| background removal / matting | stills only (depth + subject) | ✓ video, no green screen | ✓ Object Mask | ✓ Magic Mask 2.0 | ✓ Magnetic / Auto Mask | ✓ Green Screen (cloud) | ✗ | ✗ | ✓ |
| text-based editing | ✗ | ✗ | ✓ + Paper Edit | ✓ | ✗ | ✓ (its premise) | ✓ | ✗ | partial |
| **brief → finished ad** | ✓ **Director** — model picks from a menu, writes copy, validated plan, one undo, standard-cut fallback, reasons on every clip; **not yet measured on a model** | ✓ AI Ads (web) | ✗ | ✗ | ✗ | Quick Design, AI Video Maker | Agent Opus AI Ads | ✓ AI Ads from a URL | ✓ (the category) |
| copy / script generation | ✓ local LLM headlines | ✓ AI writer | ✗ | ✗ | ✗ | ✓ Underlord | ✓ | ✓ | ✓ |
| user places the assets (slots) | pool order; **no slot UI yet** | ✓ template slots (mobile/web-authored) | .mogrt controls | ✗ | Creator Themes (iPad) | Layout packs | brand templates | AI Edit styles | ✓ scene/slot editors |
| TTS / voice | ✓ local Kokoro or endpoint | ✓ + cloning | ✗ | ✓ + cloning | ✗ | ✓ Overdub | ✓ | ✓ Mirage audio | ✓ (Chirp 3 HD, Gemini TTS at Pencil ✓) |
| avatars / generated video | ✗ by design | ✓ Seedance/Seedream via Dreamina ✓ | ✓ Firefly + Veo/Kling/Runway/Luma ✓ | ✗ | Image Playground | ✓ | ✓ aggregated | ✓ Mirage Avatar X | ✓ core product |
| MCP / API surface | ✗ (rejected in `LLM.md` — different product) | ✗ | ✗ | ✓ **MCP server in 21.1** + scripting ✓ | FCPXML | ✓ REST + MCP | ✓ REST + MCP | ✓ API | ✓ APIs |
| automation is auditable and reversible per rule | ✓ every clip carries `generatedBy.reason`; Clear removes exactly one rule's output | ✗ | ✗ | ✗ | ✗ | Underlord undo | ✗ | ✗ | regenerate |
| **automation says when it degraded** | ✓ "Standard cut" vs "Directed by …" | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| metered per use | **never** | credits for generative | Firefly credits ✓ | never (Studio) ✓ | never ✓ | minutes + credits ✓ | source minutes ✓ | credits ✓ | credits / seconds ✓ |

### 2.7 Templates and library

| | Forge | CapCut | Premiere | Resolve | Final Cut | AI tools |
|---|---|---|---|---|---|---|
| "template" as a front door | **✗** — nothing is called a template; automations sit under a tab named *Auto* | ✓ the front door: pick a look, fill the slots | .mogrt + Adobe Stock | Fusion macros; third-party | Motion templates; **Apple bought MotionVFX (Mar 2026)** ✓; Creator Studio content hub | styles / playbooks / brand templates |
| transitions | 420 | very large, Pro-gated | 90+ GPU + Stock | standard + Fusion | built-in + Motion | few |
| stickers | 636 keyed cut-outs (Telugu, Hindi, memes) | large | Stock | ✗ | ✗ | some |
| fonts | 80+ bundled + system | free + Pro | Adobe Fonts | system | system | limited |
| music | ✗ | ✓ | Stock | ✗ | small | AI-generated / Shutterstock (invideo, 16 M) |
| stock footage | ✗ (Pexels API planned) | ✓ | Stock 50 M+ | ✗ | ✗ | ✓ |
| 3D props | asset kind exists, **no pack ships**; the Props tab offers a download that does not exist | effects packs | — | Fusion 3D | — | — |

---

## 3. What each one runs on

| | render / playback engine | GPU & encode | ASR | voice | AI models | compute & metering |
|---|---|---|---|---|---|---|
| **Forge** | Electron 44 + React 19; Chromium is also the tier-2 compositor (offscreen window → alpha frames); **ffmpeg** via `@ffmpeg-installer` 1.1.0 — 4.4 on macOS, a **2018-12-17 master on Windows**; one filtergraph per export | GPU only for the preview grade (WebGL); export is software `libx264` | faster-whisper 1.2.1 `small`, int8 CPU, in a Python sidecar over stdio JSON-RPC | Kokoro v1.0 ONNX (opt-in) or any OpenAI-shaped TTS endpoint | Depth Anything V2 Small (ONNX Runtime 1.30); librosa 1.0 for beats; Demucs 4 `htdemucs` opt-in; **LLM: Ollama or any OpenAI-shaped server** (LM Studio, llama-server, hosted) — Gemma 4 E2B / Qwen 3.5 4B targeted, unmeasured | **local, nothing metered**; network only to fetch |
| CapCut desktop | native app; engine **not public**; hardware decode/encode toggles and 720p/540p proxies ~ ; BMF (ByteDance's open media framework) is a plausible substrate **?** | GPU, API not named | not public | TTS, cloning, dubbing — models not named | Seedance (video), Seedream (image) via Dreamina ✓ | hybrid; privacy policy discloses pre-upload and content analysis ✓; generative is credit-metered |
| Adobe Premiere 26.5 | Mercury Playback Engine — CUDA / OpenCL on Windows, Metal on macOS ✓ | QSV, NVENC, VCN, VideoToolbox; Blackwell 4:2:2 decode ✓ | **Speechmatics on-device** since ~Apr 2026 ✓ (not Whisper) | none documented | Object Mask: Adobe model, on-device ~; Generative Extend: Firefly Video Model, cloud ✓; Generative Media Tool: Firefly + Veo, Kling, Runway, Luma ✓ | hybrid; generative in Firefly credits (CC Pro 4,000/mo) ✓ |
| DaVinci Resolve 21.1 | GPU engine; Metal (Apple silicon only in 21) / CUDA 12.8 / OpenCL ✓; 32-bit float YRGB, ACES 2.0, DCTL ✓ | NVENC, QSV, Apple media engine; MainConcept H.265/MV-HEVC ✓ | offline; **model not public** | Speech Generator with ~10 s cloning ✓ (Studio) | "DaVinci Neural Engine" — **no model names published**; IntelliSearch downloads models locally ~; NPU path on Snapdragon documented ✓ | **local, unmetered**; Blackmagic Cloud is the only paid service ✓ |
| Final Cut Pro 12.3 | Metal; Apple silicon media engine for ProRes / HEVC ✓; AVFoundation **?** | Apple media engine | **Apple-trained LLM**, one-time download, US English ✓ | none documented | Magnetic / Auto Mask, Enhance Light & Color on the Neural Engine ✓; no model cards | local; some features need an Apple Account with iCloud ✓ |
| Descript | not public; MP4-only export; QSV in the requirements **?** | not public | **not public**; 26 Latin-alphabet languages ✓ | AI Speech / Overdub; ElevenLabs on the subprocessor list **?** | Underlord picks Claude / Gemini / GPT / Grok ✓; generative media from Nano Banana, Flux, GPT Image, Veo, Kling… named per feature ✓ | cloud; media minutes + AI credits ✓ |
| Opus Clip | cloud queue; not public | n/a | not public; Brand Vocabulary implies a custom-terms bias ✓ | AI voiceover, dubbing — vendor not named | Agent Opus aggregates Kling, Hailuo, Veo, Runway, Seedance, Luma, Pika ✓ | cloud; 1 credit per source minute, rounding up ✓ |
| Captions (Mirage) | not public; "rebuilt rendering engine" Aug 2026 ✓; async job API | n/a | not public | **Mirage audio** — Mochi Transformer, flow-matching latent diffusion ✓ | **Mirage Avatar X** (first-party) ✓ + resold Veo, Kling, Seedance, Sora 2, Flux… ✓ | cloud; credits per feature ✓ |
| ad-makers | none documents an engine | n/a | not public | Pencil: Google Chirp 3 HD, Gemini 2.5 TTS ✓; Creatify: ElevenLabs Music, MiniMax Music ✓ | Creatify: Aurora (avatar), **Boreal** 22B on an open LTX base ~, $0.01/s ✓; invideo: "200+ providers", indemnity ✓; all resell Veo / Kling / Seedance / Sora | cloud; credits per generation, Predis meters edits too ✓ |

Two structural facts fall out of that table. **Every AI-first competitor is
cloud-only and metered**; the only unmetered AI on the list is Resolve
Studio's, Final Cut's, and Forge's. And **nobody publishes their ASR** except
Adobe (Speechmatics) and Apple (its own); Forge's is the only one you can
read the model name of in a requirements file.

---

## 4. Where Forge stands

### Ahead of the market
- **Local, unmetered, open.** The whole AI layer — captions, beats, depth,
  stems, voice, the Director's LLM — runs on the user's machine with no
  per-use cost. Nothing else aimed at marketers does this.
- **Auditable automation.** Every generated clip says why it exists; every
  rule clears exactly its own output; a Director plan is one undo and the
  panel says whether the model or the standard cut answered. No competitor's
  AI feature is reversible as a unit or admits when it degraded.
- **Render-side engineering** that the big NLEs get right and CapCut does not:
  equal-power crossfades derived from overlap, `amix` gain measured and
  corrected, LUFS normalisation on the export panel, colour parity between
  preview and render, pitch-correct speed both sides, a cancel that leaves no
  half-written file.
- **The library and the effects nobody else has**: 636 keyed meme stickers
  with sound, 412 tagged luma wipes, grid split, strip flashes, filmstrip,
  one-photo framing, newspaper clippings, the card ring, depth parallax and
  text-behind-subject on stills.
- **Import from a link** with a range clipped before the download.

### Behind the market — confirmed, ranked by how soon a user hits it
1. **Split and trim are wrong on any retimed clip** (bug). `timeline.ts:869-907`
2. **The preview lies twice**: every transition is a dissolve, and the audio
   mix — envelope, fades, crossfades, ducking — is not heard. `Preview.tsx:817, 605, 671`
3. **No multi-select, copy, paste, duplicate, ripple delete, right-click.**
4. **The timeline does not follow the playhead.**
5. **Nothing protects the work**: no autosave, no close guard, no recovery, no
   File menu, no Recent, no Save As; Save is an undiscoverable ⌘S.
6. **Missing media is black and unrelinkable**; paths are absolute, so a
   project does not survive a moved folder or the other machine.
7. **Audio surface**: no gain above 0 dB, no solo, no meters, no detach, no
   scrub audio, no voice-over recording.
8. **Export is one shape**: H.264 CRF 20 mp4, 1080-class, 30 fps, software
   encode.
9. **Colour lacks temperature/tint**; masks do not track; no chroma key; the
   twelve camera moves the app renders for itself cannot be set by hand.
10. **A transcript cannot be corrected**, so a misheard brand name is burned in.
11. **First hour**: new projects are 16:9 landscape with nothing asking; files
    dropped on the preview or timeline do nothing; the empty state says only
    "Drop media here"; the word *template* appears nowhere.

### Different by design, and worth keeping
- Plans, not tool calls, for the LLM — one undo, validated before anything
  is touched, testable as data (`docs/LLM.md`).
- The user places the assets; the model never reorders them.
- Stills-first automation (reel, one-photo, grid, ring) as the wedge — the
  video-subject-tracking gap is real, but the ad from product photographs is
  the product today.

---

## 5. What this means

The core is real and, in places, better than the free competitor's. The
editing surface is roughly a fortnight of unglamorous work from being one a
CapCut user would not bounce off: the two speed bugs, the two preview lies,
multi-select with the clipboard trio and ripple delete, playhead follow,
autosave with a close guard, relink, a File menu. None of it needs a model,
a new library or a design decision — each is a known behaviour with a known
shape in four other products.

The Director is the bet, and it is unmeasured. Until a 2–4B model has been
run against real footage (`docs/LLM.md`, "two things to measure first"), the
comparison in §2.6 is a comparison of architectures, not of output.

---

## 6. Sources read by the research agents (selection)

CapCut: capcut.com/tools/desktop-video-editor · capcut.com/resource/capcut-standard-vs-pro · capcut.com/help/how-to-set-replaceable-material-clips · capcut.com/clause/privacy-policy · capcut.com/tools/ai-ads · dreamina.capcut.com/seedance/seedance-2-5 · github.com/BabitMF/bmf
Premiere: blog.adobe.com (20 Jan 2026) · community.adobe.com "What's new in Adobe Premiere 26.5 / 26.3" · speechmatics.com (Adobe on-device STT) · nofilmschool.com (Generative Media Tool)
Resolve: blackmagicdesign.com/products/davinciresolve (+ /compare) · sportsvideo.org (IBC 2026, 21.1) · cgchannel.com (21.0, 20.0) · thepostflow.com/ai/ai-in-davinci-resolve
Final Cut: support.apple.com/en-us/102825 (release notes) · apple.com/final-cut-pro · apple.com/newsroom (FCP 11; Creator Studio) · support.apple.com/guide/final-cut-pro (Generate Captions; Auto Mask / Magnetic Mask)
Descript: descript.com/pricing · descript.com/underlord · descript.com/subprocessors · descript.com/research · help.descript.com (system requirements, media minutes & credits, export, subtitles, Quick Design)
Opus Clip: opus.pro/pricing · help.opus.pro (plans and credits, virality score, layout and reframing, Agent Opus FAQ) · opusclip.canny.io/changelog
Captions: captions.ai/pricing · captions.ai/help (timeline, feature availability, AI Ads, API pricing) · captions.ai/blog/mirage-avatar-x
Ad-makers: creatify.ai (pricing, api, ai-models) · labs.creatify.ai/models/boreal · invideo.io (pricing, agent-two) · pencil.ai · veed.io/ai · predis.ai
