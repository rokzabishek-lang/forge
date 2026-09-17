/**
 * Turning the sketch's quality ladder into a yt-dlp format selector.
 *
 * Sheet 6 asks for "4K, 1080p, 720p, 480p" and an mp3 option. What it does not
 * say — because nobody drawing a sketch would — is that the choice is
 * constrained at the far end by which ffmpeg does the muxing.
 *
 * YouTube serves 1080p and above as SEPARATE video and audio streams. yt-dlp
 * downloads both and shells out to ffmpeg to put them in one container, and the
 * ffmpeg it is handed is ours: 4.4 on macOS, a master snapshot from 2018-12-17
 * on Windows (CLAUDE.md, docs/EFFECTS.md section 25). So the safe set is what
 * BOTH can mux, and the rule is the usual one — merged before that date.
 *
 *   H.264 + AAC in mp4      safe since roughly 2012, and the common case
 *   VP9 + Opus in webm      VP9 landed 2013, Opus 2012; both are native to the
 *                           container, so there is nothing to remux
 *   AV1                     EXCLUDED. AV1 in mp4 postdates the snapshot, and
 *                           YouTube offers av01 at every size now — so without
 *                           an explicit exclusion the "best" stream is the one
 *                           that breaks on Windows and works on the machine it
 *                           was written on. Exactly the shape of the three bugs
 *                           section 25 already documents.
 *
 * None of this costs quality: YouTube's VP9 at 2160p is the same picture as its
 * AV1 at 2160p, a little larger on disk.
 */

/** The ladder as the sheet draws it. */
export type Quality = '2160p' | '1080p' | '720p' | '480p'

export const QUALITIES: readonly Quality[] = ['2160p', '1080p', '720p', '480p']

/** What to pull down: the picture, or only the sound. */
export type IngestKind = 'video' | 'audio'

export interface FormatChoice {
  /** The `-f` argument. */
  selector: string
  /** `--merge-output-format`, or null when nothing needs merging. */
  mergeFormat: 'mp4' | 'webm' | null
  /** The extension the finished file will have, for the probe that follows. */
  expectedExt: string
}

const HEIGHT: Record<Quality, number> = {
  '2160p': 2160,
  '1080p': 1080,
  '720p': 720,
  '480p': 480
}

/**
 * `<=?` rather than `<=`.
 *
 * The `?` makes the filter non-strict: a video that simply is not available at
 * the asked-for size still matches instead of failing the whole selection.
 * Plenty of YouTube is 720p at best, and "you asked for 1080p so you get
 * nothing" is not a useful answer.
 */
function cap(quality: Quality): string {
  return `[height<=?${HEIGHT[quality]}]`
}

export function formatFor(kind: IngestKind, quality: Quality): FormatChoice {
  if (kind === 'audio') {
    /*
     * Audio alone never merges — one stream, one file. m4a first because it is
     * what YouTube actually stores, so it copies out without re-encoding;
     * caller adds `-x --audio-format mp3` when the sketch's mp3 is wanted, and
     * our bundled ffmpeg has libmp3lame for it (checked, not assumed).
     */
    return {
      selector: 'bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio',
      mergeFormat: null,
      expectedExt: 'm4a'
    }
  }

  const size = cap(quality)

  /*
   * Read as three attempts, in order:
   *
   *   1. H.264 video + AAC audio            -> mp4, the friendliest result
   *   2. anything except AV1 + any audio    -> webm, which is where VP9/Opus live
   *   3. a single pre-muxed stream          -> whatever it already is
   *
   * The third exists because some videos have no separate streams at all, and
   * because it is the branch that still works if YouTube changes the other two
   * out from under us.
   */
  const h264 = `bestvideo${size}[vcodec^=avc1]+bestaudio[acodec^=mp4a]`
  const notAv1 = `bestvideo${size}[vcodec!*=av01]+bestaudio[acodec!*=opus]/bestvideo${size}[vcodec!*=av01]+bestaudio`

  /*
   * Above 1080p, H.264 must NOT be tried first — and this is the bug that
   * shipped in the first version of this file.
   *
   * yt-dlp's `/` is fallback-only: the first branch that matches anything wins,
   * and it never looks at the ones after it. YouTube publishes no avc1 above
   * 1080p, so for a 2160p request the H.264 branch matched the 1080p stream and
   * was satisfied by it. Asking for 4K returned the same file as asking for
   * 1080p — cached under a 4K name, so a retry served it straight back.
   * Reproduced against the real yt-dlp with a YouTube-shaped `--load-info-json`:
   * the selector chose `137+140 1080 avc1`, where `313+140 2160 vp09` existed.
   *
   * So for the rungs above 1080p a `[height>1080]` branch goes first. It is
   * NOT a plain replacement: a video that tops out at 1080p matches nothing
   * there and falls through to the H.264 branch, which is still the friendliest
   * answer for it.
   */
  const above1080 =
    HEIGHT[quality] > 1080
      ? `bestvideo${size}[height>1080][vcodec!*=av01]+bestaudio[acodec!*=opus]/` +
        `bestvideo${size}[height>1080][vcodec!*=av01]+bestaudio/`
      : ''
  /*
   * AV1 is excluded here too, even though a single pre-muxed stream needs no
   * merging and so dodges the ffmpeg-version problem on the way in.
   *
   * It does not dodge it afterwards. The file still has to be decoded for the
   * preview and for every render, and the 2018 Windows build has no AV1
   * decoder at all. Allowing it would trade a download that fails with a clear
   * message for an import that succeeds and then cannot be played or exported
   * — the worse failure, and much later.
   *
   * In practice YouTube offers VP9 beside AV1 at every size, so this costs
   * nothing; if a video ever is AV1-only, saying so is the right answer.
   */
  const single = `best${size}[vcodec!*=av01]`

  return {
    selector: `${above1080}${h264}/${notAv1}/${single}`,
    // mp4 is requested rather than assumed: when branch 1 wins there is nothing
    // to do, and when branch 2 wins yt-dlp falls back to a container that fits
    // rather than failing. Naming mkv here instead would push every ordinary
    // 1080p download into a needless remux.
    mergeFormat: 'mp4',
    expectedExt: 'mp4'
  }
}

/**
 * The arguments that do not depend on the format.
 *
 * `%(id)s` names the file, never `%(title)s` — see the note in url.ts. The
 * title comes back separately and becomes the asset's display name.
 */
export function outputTemplate(key: string): string {
  return `${key}.%(ext)s`
}
