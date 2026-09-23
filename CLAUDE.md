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
| `docs/LLM.md` | the LLM design — the plan schema, the passes, what was rejected and why, and what is built |
| `docs/COMPARISON.md` | Forge against CapCut, Premiere, Resolve, Final Cut and the AI ad tools — every confirmed gap with its file:line, and what each runs on |
| `docs/FIX.md` | the fix list that closed those gaps — Phases A and B, both DONE, each item with what was actually built — then the agreed summary of Phase C and the record of Phase D (folded into C) |
| `docs/PLAN.md` | **the current plan: Phase C, the ad-maker** — recipes, eyes, the rhythm engine, sound design, the three.js moments engine — step by step with files, schemas, tests, render checks and an exit bar each. Read before building anything in C |
| `docs/MARKET.md` | the later part: templates with slots, free packs, then a store — its prerequisites, rights rules, money and risks. Not current work |
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

**And check what your anchor matched.** Three separate times, a mutation or an
assertion landed on the wrong occurrence of a string that appears more than
once — and every one of them *looked* like it had worked:

| anchor | found | meant |
|---|---|---|
| `const shift = frames - already` | `addTransition` | `crossfadeAt` |
| `toContain('width,')` | the function's arguments | the asset repoint below them |
| `store.indexOf('bakePaperSequence(')` | the first of **two** call sites | both of them |

The last one shipped a test that passed with the bug reintroduced. So: before
trusting a string anchor, count the matches. Use `matchAll` and assert over
every site, or anchor on text that is unique, and prefer a whole ordered shape
to three loose substrings.

**Never pipe a test run into a filter and then act on the result.**

    npm test | grep -E "Tests |FAIL" && git commit ...   # WRONG

That commits over a red suite, every time. The exit code belongs to `grep`,
which matched, so the chain continues however many tests failed — and it did:
a commit went out with three failures and was pushed. Write the output to a
file, check `$?`, then read the file.

**And an assertion that breaks when the guarded thing is done RIGHT is not a
guard.** Three tests pinned the exact contents of a list — `c.text || c.solid
|| c.title || c.paper` — and failed the moment a fourth self-drawing kind was
correctly added to it. Assert MEMBERSHIP of the thing under test, not the whole
snapshot, and mutation-check that the relaxed version still catches its
original bug.

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

**Assert on the basename, never the path.** The corollary, and it has its own
scar: `expect(path).not.toMatch(/[<>:"|?*]/)` was written to prove no illegal
character from a title reached a filename. Every absolute Windows path carries
a drive-letter colon, so it could never pass there — and no `/Users/…` path has
one, so it passed unconditionally here. Wrong in both directions at once, from
the same confusion the escaping rule above already records: **a drive-letter
colon is not content.** If an assertion is about a *name*, take `basename()`
first.

**A path ending in a separator is not portable.** `writeFile('…/dir/', '')`
throws on macOS and SUCCEEDS on Windows, creating a file where a directory was
about to go. A `.catch(() => undefined)` around setup turns that into dead code
on one platform and a landmine on the other.

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
npm run pack:win    # electron-builder — must run ON Windows, see below
```

CI runs typecheck, the **full** suite including the ffmpeg integration tests,
and the build, on **Windows** for every push — macOS joins on a `v*` tag or a
manual run (`a2be321`, runner cost), so the Mac is covered by running the suite
locally. **Read the result after every push**: it is at
github.com/spyki-a/forge/actions (the `gh` CLI cannot reach GitHub from the
sandbox), and a failure's message is in its annotations without signing in.
CI was red on Windows for a day in B3 before anyone looked. The integration tests are
in CI deliberately: a runner's `D:\a\forge\forge` path is exactly the shape that
breaks filter arguments.

**Packaging works** — `electron-builder.yml`, and a CI job that builds an
installer on each platform and uploads it as an artifact. A CI-built Windows
installer has been installed and run successfully on the Surface. Read
`docs/PACKAGING.md` before touching it; three paths in `src/main` only resolve
because that config puts something where they look, and none of them can fail
in development.

**Each platform must build itself.** `@ffmpeg-installer` ships its binary as an
optional dependency per platform, so `npm ci` on a Mac installs only
`darwin-arm64` — `npm run pack:win` from macOS yields an installer with no
ffmpeg at all, and the app greets the user with `assertBinaries()`'s dialog.
Get the Windows installer from CI, or build it on the Surface.

Neither build is signed yet, and `productName` is still the placeholder
`Forge`.

---

## A fresh Windows checkout

Four things the repo cannot install for you. `npm ci` exits 0, reports 0
vulnerabilities, and is not finished.

| missing | what you actually see | fix |
|---|---|---|
| Electron's binary | `node_modules/electron/dist/` empty. npm 11's allow-scripts gate withholds the postinstall, and its warning names only `electron-winstaller` and `esbuild` — **never `electron`**. `esbuild` needs nothing; its platform package ships the exe | `node node_modules/electron/install.js` |
| Visual C++ Redistributable | *Cannot find native binding … npm bug 4828*, from `@electron-internal/extract-zip`. The message is wrong — `index.win32-x64-msvc.node` is present and bundled. `vcruntime140.dll` is not, so `dlopen` fails | `winget install Microsoft.VCRedist.2015+.x64` |
| a real Python | the twelve sidecar tests fail with `SidecarError: The sidecar stopped (code 9009)`. 9009 is Windows for *command not found* — `python3` resolves to the Store App Execution Alias stub, which is not an interpreter | `winget install Python.Python.3.12` |
| `FORGE_PYTHON` | still 9009 once Python is in. `client.ts` falls back to the literal `python3`, and the python.org installer creates `python.exe` and no `python3.exe`. CI passes only because `actions/setup-python` makes one | `setx FORGE_PYTHON "…\Python312\python.exe"` |

The first two are independent, by elimination: a clean `npm ci` with the runtime
already present still produced no `electron.exe`, and the manual installer still
failed without it. Fixing either alone leaves you stuck.

**The Electron one is not first-run setup — it recurs.** Every `npm ci` in this
repo drops that binary again, silently, with a zero exit code. Check
`node_modules/electron/dist/electron.exe` before trusting an install, and before
`npm run pack:win`, which needs it and will not tell you why it failed.

**The sidecar needs only a bare interpreter**, not `requirements.txt`. CI runs
`setup-python` with no `pip install`, and one of the twelve tests is "reports a
missing capability as degraded rather than crashing". Install the requirements
when you want the capabilities, not to get the suite green.

Each of these reports something other than its cause. None is discoverable by
reading the code.

---

## Working across two machines

The repo is the only thing shared between the macOS and Windows checkouts —
conversations and per-machine memory do not travel. Pull before starting, push
before switching, and do not edit the same files from both at once.

`.gitattributes` normalises line endings (`* text=auto eol=lf`), so a fresh
Windows clone should show a clean `git status`. If it does not, stop and work
out why before committing anything.

**Git works on both machines now.** The macOS sandbox used to block writes to
`.git/`, and this file said so for a long time after it stopped being true —
the constraint was taken as permanent and never retested. `git pull` and
`git commit` both work here. Retest a documented limit before planning around
it. That machine has no global git identity,
so `user.name` and `user.email` are set per-repo there — check `git config
--local --list` if a commit lands under the wrong name.
