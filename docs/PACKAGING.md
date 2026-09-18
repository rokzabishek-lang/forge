# Packaging — turning this into something you can install

Until this existed the app worked and could not be installed, which for a
desktop tool is the same as not existing. Everything else on the roadmap is
features; this was the gate.

**Status:** working. `electron-builder.yml` is the whole config;
`.github/workflows/ci.yml` builds an installer on each platform and uploads it
as an artifact.

**A CI-built Windows installer has been installed and run successfully** — so
the asar unpack, the bundled ffmpeg, the sidecar's placement and the first-run
path are all confirmed on a real machine rather than inferred from a green
tick. The only known gap is the asset library, below.

---

## The rule that decides everything: each platform builds itself

`@ffmpeg-installer` ships its binary as an **optional dependency per
platform**:

```
@ffmpeg-installer/darwin-arm64    @ffmpeg-installer/win32-x64    …
```

`npm ci` installs only the one matching the machine it runs on. So on this Mac,
`node_modules/@ffmpeg-installer/` contains `darwin-arm64` and nothing else —
and **`npm run pack:win` from macOS produces a Windows installer with no ffmpeg
in it at all**. The app installs, starts, and greets the user with
`assertBinaries()`'s error dialog, on a machine nobody can debug from here.

That is why the packaging job is a matrix, not a cross-compile. The Windows
installer is built on `windows-latest`, the macOS one on `macos-latest`. It also
means **you cannot produce a Windows installer from the Mac** — get it from the
CI artifact, or build it on the Surface itself.

---

## What has to land where, and why

Three paths in `src/main` only resolve correctly because the config puts
something there. None of them can fail in development — `app.isPackaged` is
false and every one takes the other branch — so a mistake here is invisible
until someone installs the result. `tests/packaging.test.ts` pins all three.

| code | expects | config |
|---|---|---|
| `ffmpeg/paths.ts` `resolveBinary()` | `app.asar.unpacked/node_modules/@ffmpeg-installer/…` | `asarUnpack` |
| `assets/scan.ts` `assetsRoot()` | `process.resourcesPath/assets` | `extraResources` |
| `sidecar/service.ts` `sidecarDir()` | `process.resourcesPath/sidecar` | `extraResources` |

**Nothing can be executed from inside an asar archive**, and Python cannot
import from one either. That single fact is the reason for both mechanisms.

### What is deliberately left out

- **`sidecar/.venv`** — 542MB, and built for one interpreter on one platform.
  A user's Python is their own; `docs/SIDECAR.md` covers setting it up, and
  until they do the sidecar reports every optional capability as degraded
  rather than failing to start. The `requirements*.txt` files DO ship, so the
  setup step is available on the installed app.
- **`sidecar/:memory:.ses`** — a colon is illegal in a Windows filename, so an
  installer carrying this would fail to extract on the platform it is aimed at.
  It is gitignored, which is not the same as unpackaged.
- **`__pycache__`, `.pyc`** — noise, and compiled for whatever interpreter
  happened to be here.

### The asset library is NOT in a CI-built installer

`assets/` is gitignored — `docs/ASSETS.md` §"Open decision" explains why, and
the decision is still open. A CI checkout therefore has no asset library, and
**electron-builder treats a missing `extraResources` source as nothing to copy
rather than as an error.** The installer builds, installs, starts and works,
with an empty Library tab and nothing anywhere saying why.

Verified by unpacking the real artifact: `ffmpeg.exe`, `ffprobe.exe`, sharp's
native binding, the sidecar and its `requirements*.txt` were all present and
correct; `resources/assets/` was absent entirely.

This is now reported in the packaging job — a warning before the pack, and a
listing of what landed after it. It does not fail the build, because an
installer without the asset pack is still worth having: everything except the
Library works, and `scanAssets` was written to degrade to an empty catalog
rather than to fail.

**The three options are in `docs/ASSETS.md`, which already prefers shipping the
assets as a separate first-run download** — the same shape as the models and as
yt-dlp. Until that is built, a CI installer has no library.

### What is not solved

- **Neither build is signed.** macOS will refuse to open the DMG without
  right-click → Open, and Windows SmartScreen will warn on first run. Signing
  needs a paid Apple Developer ID and a Windows code-signing certificate; both
  are a decision, not a config change.
- **`yt-dlp` is not bundled** and should not be — it is fetched on first use
  into `userData` and can be refreshed without shipping anything. See
  `docs/INGEST.md`.
- **The name is a placeholder.** `productName: Forge` and
  `appId: in.syncpod.forge` are in `electron-builder.yml`; changing them is a
  two-line edit, and it is much cheaper to do before installers exist in the
  wild than after.
- **The icon is a placeholder** — `build/icon.png`, a shutter aperture in the
  app's own accent colour. Replace the file; nothing references it by content.

---

## Getting an installer

**From CI**, which is the supported route:

1. Push. The `installer` job runs after the test matrix is green on both
   platforms — an installer built from a red commit is a thing someone will
   install.
2. Open the run on GitHub → Artifacts → `forge-windows-latest`.
3. Unzip, run the `.exe`.

**On the Surface itself**, if you want one without waiting — but read
`CLAUDE.md`'s "A fresh Windows checkout" first, because `npm ci` there exits 0,
reports no vulnerabilities, and is not finished:

```
npm ci
node node_modules/electron/install.js
npm run pack:win
```

The middle line is not optional and not one-time. On Windows, `npm ci` can
leave `node_modules/electron/dist` empty — npm 11's allow-scripts gate withholds
electron's postinstall, and its warning names `electron-winstaller` and
`esbuild` but never `electron`. It recurs on every `npm ci`. `install.js`
short-circuits when the binary is present, so running it always costs nothing.
CI does exactly this, and fails loudly if the binary still is not there.

The installer lands in `dist/`.

---

## The first run on a clean machine

A machine that has never had a developer tool on it is a test you get **once**,
and it is the only place several things can fail. In order, and what each
answers:

1. **It starts at all.** Rules out a missing Visual C++ runtime, a broken asar
   unpack, and a wrong-architecture binary.
2. **No error dialog.** `assertBinaries()` runs at startup; if ffmpeg did not
   make it into the package, this is where it says so.
3. **The Library tab is EMPTY, and that is expected** for a CI-built installer
   — the asset library is gitignored and not in the package. What this step
   actually proves is that an empty catalog degrades rather than crashes.
   A full library needs the first-run asset download, which is unbuilt.
4. **Import a photo and export three seconds.** The whole media pipeline, in
   one go.
5. **Paste a YouTube link.** The first download fetches yt-dlp (~30MB) — this
   is where a missing runtime or a blocked network shows itself, and where the
   fetch's checksum verification either works or says why not.
6. **The sidecar says "degraded", not "failed".** With no Python installed the
   app must still be completely usable; anything else is a bug.
