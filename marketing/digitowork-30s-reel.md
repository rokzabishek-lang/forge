# DigitoWork — 30s Reel (3 × 10s Flow/Veo clips)

## Scraped brand facts (digitowork.com, fetched 2026-09-16)

- **Name:** DigitoWork · **Tagline:** "Enterprise-Grade Asset Intelligence. Proactive Cybersecurity. Complete Control."
- **Two product halves:** (1) Asset intelligence — Tag, Track, Trace, Verify & Monitor. (2) App security — PEN testing, vulnerability assessment, defensive/passive security.
- **Killer differentiator:** **ISO 17025 accredited security testing lab** (rare; this is the one fact worth building the whole campaign on).
- **Second hook:** "Funding-Ready PEN Test for Founders" — startup-shaped, actually shareable.
- **Framework:** See IT / Serve IT / Secure IT / Save IT
- **Verticals:** Hospitals & biomedical equipment (BME), manufacturing, universities/education, retail malls, IT enterprise
- **Compliance angles:** HIPAA, PCI-DSS, ISO 27001, SOC2, GDPR pen testing
- **Objections they already answer:** no license fees, no vendor lock-in, flat-rate pricing, scale up/down, continuously updated test cases
- **Proof assets:** ROI Calculator, Maturity Index, client logos (RDS, Mitra, Tripee, Vedhas, Differntech, Brand), testimonials (Stacy/CISO, Rufus/IT Security Manager, Rob/Asset Manager)
- **Contact:** sales@digitowork.com · +91 8309396730 · +1 201-256-7749 · 221 W 9th St, Wilmington, DE 19801
- **Brand colors:** primary blue `#1863DC`, deep blue `#086ABD` / `#0056A7`, accent teal `#0ABFA0`, dark green `#1B3A2F`, alert orange `#E8420A`, near-black `#212121`
- **Logo:** https://digitowork.com/wp-content/uploads/2025/01/Digitowork-logo.png

---

## The 30s script — "The 90 Devices You Can't See"

| Time | Beat | On-screen text | VO |
|---|---|---|---|
| 0.0–1.5s | HOOK | "Your company owns 400 devices." | "Your company owns four hundred devices." |
| 1.5–10s | Problem | "Your spreadsheet knows about 310." | "Your spreadsheet knows about three hundred and ten. The other ninety are somebody's way in." |
| 10–20s | Mechanism | "Tag. Track. Trace. Verify." | "DigitoWork finds every asset, then attacks it — the way a real adversary would." |
| 20–27s | Proof | "ISO 17025 accredited lab" | "From an ISO 17025 accredited security testing lab. Flat rate. No licenses. No lock-in." |
| 27–30s | CTA | "Free demo → digitowork.com" | "Find your ninety." |

---

## Clip prompts for Google Flow / Veo

**Paste this CONSISTENCY BLOCK verbatim at the end of all three prompts:**

> Style: cinematic corporate documentary, anamorphic 35mm look, shallow depth of field, teal-and-deep-blue color grade (#1863DC key light, #0ABFA0 accents), volumetric haze, high contrast, clean modern architecture, no on-screen text, no logos, no captions, no watermarks. Vertical 9:16 framing. Audio: ambient room tone only, no dialogue, no music, no narration.

### CLIP 1 (0–10s) — the hook
> A vast open-plan corporate office at night, completely empty of people. Hundreds of desks recede into darkness, each with a monitor in standby, glowing faint blue. Slow, steady dolly push forward down the center aisle at chest height. Rows of small status lights blink across the room; in the far half of the room, a scattering of devices sit completely dark and unlit. Dust drifts through a shaft of light from a window. Cold moonlight from the left, blue monitor glow filling the room.
>
> [CONSISTENCY BLOCK]

### CLIP 2 (10–20s) — the mechanism
> A modern security operations room, low light. Over-the-shoulder shot of a focused analyst in a dark shirt seated at a curved multi-monitor desk, hands on keyboard, face lit blue by the screens. Abstract glowing data grids and node maps move across the displays; a wave of small indicators sweeps left to right across one screen. Camera slowly arcs right around the analyst's shoulder as they lean in. Shallow focus, screen bokeh in the foreground, teal rim light from the right.
>
> [CONSISTENCY BLOCK]

### CLIP 3 (20–30s) — proof + CTA plate
> A pristine modern laboratory corridor with glass-walled server and test rooms on both sides, lit by cool blue strip lighting along the ceiling. Two professionals in dark business attire walk away from camera down the corridor in calm conversation, unhurried and confident. Smooth steadicam tracking shot following behind them at waist height. At the end of the corridor, a bright clean doorway of soft white light. The corridor is minimal, spotless, with no signage or text on the walls.
>
> [CONSISTENCY BLOCK]

**Why no text/logo in the prompts:** Veo garbles typography and invents fake logos. Every word and the logo goes on in the edit.

---

## Making 3 clips read as one film — the five rules

1. **Kill Veo's native audio on all three.** Lay ONE music bed + ONE VO across the full 30s in the edit. Audio continuity is 80% of "this is one video." Different room tone at each cut is the #1 AI-stitch tell.
2. **One grade across all three.** Apply the same LUT/curve to the merged timeline, not per clip.
3. **Match motion direction.** All three above push/track forward — the cut reads as momentum, not as a jump.
4. **Don't carry a human face across a cut** unless you use Flow's reference-image/ingredients feature. Clip 1 is empty, clip 3 is shot from behind — faces never have to match.
5. **Cut on the beat.** Land the cuts at 10.0s and 20.0s exactly on a music transient and nobody reads them as separate generations.

Optional, if your Flow build has it: generate clip 1, export its **final frame**, feed it as the start frame of clip 2 (Frames-to-Video / Extend). That gives a true continuous 30s take instead of three shots.

## Merge

```bash
printf "file 'clip1.mp4'\nfile 'clip2.mp4'\nfile 'clip3.mp4'\n" > list.txt
ffmpeg -f concat -safe 0 -i list.txt -an -c:v libx264 -crf 18 -pix_fmt yuv420p video.mp4
ffmpeg -i video.mp4 -i vo.wav -i music.wav -filter_complex "[1:a]volume=1.0[v];[2:a]volume=0.22[m];[v][m]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest reel_30s.mp4
```

Export: 1080×1920, 30fps, H.264, ~8–12 Mbps. Burn captions (85% of feed views are muted).

## Alternate hooks to A/B

- "We broke into a hospital in 4 minutes. They hired us to." (funding-ready PEN test angle)
- "The most dangerous device in your building is the one nobody logged."
- "Your last pentest was a PDF. Your next one should be a lab report." (ISO 17025)

## Hard rules for a security brand

- Don't fabricate stats, client names, or breach stories. Use only what's on the site.
- Label as AI-generated where the platform asks. Veo output carries SynthID; IG/TikTok may auto-tag it.
- Never show a real-looking dashboard with plausible fake customer data.
