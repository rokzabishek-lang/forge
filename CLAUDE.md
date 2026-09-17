# Forge

An Electron video editor with AI automation, aimed at short-form content, with
weddings and photography as the first niche. Ships on **macOS and Windows**.
Electron 44 + electron-vite + React 19 + TypeScript + Zustand + Tailwind v4.

"Fully local" here means **no per-use API cost**. It does not mean no network.

---

## Read these before planning anything

The important knowledge in this project is written down, because it came from
measurements and paper sketches that do not survive a new session.

| file | what it holds |
|---|---|
| `docs/SHEETS.md` | the eighteen planning sketches, transcribed, each with build status |
| `docs/REFERENCES.md` | the reference recordings, what each was measured at, repo/CI facts |
| `docs/EFFECTS.md` | ~1,900 lines: every effect, and every ffmpeg finding that cost real time |
| `docs/WHERE-THINGS-ARE.md` | a map of the UI — read before adding a panel nobody can find |
| `docs/STACK.md`, `docs/SIDECAR.md` | architecture and the optional Python capabilities |

Before re-measuring something against ffmpeg, check whether `EFFECTS.md` already
did. Before proposing what to build next, read `SHEETS.md`.

---

## How to work on this

**Measure, do not assume.** Every ffmpeg capability in this project was probed
against the bundled binary before being relied on, and the assumptions that were
*not* probed are where the bugs came from. If you are about to say "ffmpeg
supports X", run it first.

**Regression tests must be mutation-checked.** Write the test, then put the bug
back and confirm the test fails. This is not ceremony: **four separate tests in
this project were found asserting the broken behaviour they were meant to
guard.** A test that passes against the reintroduced bug is worse than no test,
because it certifies the bug.

**The user's settled decisions.** Licensing and sourcing questions for the
models and tools this project uses have been decided. Do not reopen them, and do
not flag `yt-dlp` — it is an accepted dependency here.

---

## The constraints that actually bite

**Two different ffmpegs.** `@ffmpeg-installer` ships a different build per
platform, and the Windows one is not a release:

| platform | package | build |
|---|---|---|
| macOS arm64 | 4.1.5 | `92718-g092cb17983` — reports 4.4 |
| win32-x64 | 4.1.0 | `20181217-f22fcd4` — **master, 17 Dec 2018** |

So the floor is a **date, not a version**: a filter or option is safe if it was
*merged* before **2018-12-17**, whatever release first carried it. `tpad` first
ships in 4.2 and works fine on Windows because it merged in October 2018.
`anullsrc:d`, `adelay:all` and `amix:normalize` all merged later and kill every
render there. `tests/oldestFfmpeg.test.ts` enforces this locally; `EFFECTS.md`
§25 has the history.

**Filtergraph path escaping is not uniform.** Measured, not guessed:
`, [ ] ;` need one backslash, `: =` need two, `'` needs three, space needs none.
One backslash on a colon eats the Windows drive letter. See
`src/shared/captions/timeline.ts` and `tests/integration/filterPath.int.test.ts`.

**Windows filename rules.** `< > : " | ? *` are illegal, plus trailing dots and
spaces and the reserved names (CON, NUL, COM1-9…). This has bitten a committed
file, a test fixture, and is a live risk anywhere a filename is built from a
user's data — `Bride 5:30pm.jpg` is an ordinary wedding filename.

**Spawning.** Every `execFile` of a bundled binary in `src/main` passes
`windowsHide: true`. A packaged Electron app has no console of its own, so each
console-subsystem child without it opens a visible window.

**The renderer has no `node:path`.** Join asset paths with
`src/shared/assetPath.ts`, never a template literal — the two sides of the IPC
have to produce the same string or every path comparison silently fails on
Windows.

---

## Commands

```
npm run dev         # electron-vite dev
npm run typecheck   # both tsconfigs
npm test            # vitest, integration tests included
npm run build       # electron-vite build
npm run pack:win    # electron-builder — no config yet, see below
```

CI runs typecheck, the **full** suite including the ffmpeg integration tests,
and the build, on macOS **and** Windows for every push. The integration tests are
in CI deliberately: a runner's `D:\a\forge\forge` path is exactly the shape that
breaks filter arguments.

**Known gap:** `pack:mac`/`pack:win` exist as scripts but there is no
electron-builder configuration yet, and CI uploads no artifacts. Producing a
real installer is unfinished work.

---

## Working across two machines

The repo is the only thing shared between the macOS and Windows checkouts —
conversations and per-machine memory do not travel. Pull before starting, push
before switching, and do not edit the same files from both at once.

`.gitattributes` normalises line endings (`* text=auto eol=lf`), so a fresh
Windows clone should show a clean `git status`. If it does not, stop and work
out why before committing anything.

On the macOS machine the assistant's sandbox blocks writes to `.git/`, so
**commits and pushes are run by the user by hand**. That may not be true on
Windows — check rather than assume.
