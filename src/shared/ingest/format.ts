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
  /** The `-S` argument — how to choose among what `-f` allows, or null. */
  sort: string | null
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
      sort: null,
      mergeFormat: null,
      expectedExt: 'm4a'
    }
  }

  /*
   * `-S res:N`, not `-f [height<=N]`. This is the second bug this file has had
   * from picking formats the wrong way, and it was the worse of the two.
   *
   * `height<=?1080` rejects EVERY VERTICAL VIDEO. A 1080p reel is 1080 wide and
   * 1920 tall, so its height fails the filter, no branch matches, and yt-dlp
   * answers "Requested format is not available". Measured against the real
   * yt-dlp with shaped `--load-info-json` files: a landscape 1080p video
   * downloaded fine while a YouTube Short and an Instagram reel both failed
   * outright. For an app whose entire subject is short-form vertical video,
   * every Short and every reel was unreachable.
   *
   * yt-dlp's sort field `res` is the LOWER of height and width, which is what
   * everyone means by "1080p" for a vertical clip. Verified across a vertical
   * ladder: asking 360/720/1080/2160 returns exactly that rung each time.
   *
   * Sorting also fixes the trap that caused the FIRST bug here. `/` in `-f` is
   * fallback-only — the first branch matching anything wins and the rest are
   * never considered — which is how a 4K request used to be satisfied by a
   * 1080p stream. A sort has no branches to be trapped in: every allowed
   * format is ranked, so 4K still comes back 4K (verified), and a missing rung
   * degrades to the nearest one below rather than failing.
   *
   * Codec is a PREFERENCE here rather than a filter, for the same reason: h264
   * and m4a are ranked first, but a site that has neither still downloads.
   */
  const sort = `res:${HEIGHT[quality]},vcodec:h264,acodec:m4a`

  /*
   * AV1 stays a hard filter, and is the one thing that may still refuse.
   *
   * It is not about the download. The file has to be decoded for the preview
   * and for every render, and the 2018 Windows build ships no AV1 decoder at
   * all (docs/EFFECTS.md §25). Allowing it would trade a download that fails
   * with a clear message for an import that succeeds and then cannot be played
   * or exported — the worse failure, and much later.
   */
  return {
    selector: 'bv*[vcodec!*=av01]+ba/b[vcodec!*=av01]',
    sort,
    // Requested rather than assumed: when the parts are already mp4 there is
    // nothing to do, and when they are not yt-dlp falls back to a container
    // that fits rather than failing.
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
