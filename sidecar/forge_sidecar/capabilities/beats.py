"""Beat, downbeat and onset detection.

docs/STACK.md selected madmom, but madmom 0.16.1 has no wheel for this
interpreter and does not build on modern Python — it predates several numpy
removals. librosa is the working backend; Beat This! (MIT, and from the same lab
as madmom) remains the quality upgrade and fits behind this same capability.

Audio is decoded by the ffmpeg the app already ships rather than by librosa's
own loader, so there is exactly one ffmpeg version in the product and no second
audio-decoding dependency.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any

from ..rpc import Context, Server, Unavailable

ANALYSIS_RATE = 22050
"""Enough for percussive onsets; higher rates cost time and change nothing here."""

ONSET_SNAP_MS = 50
"""How far a predicted beat may move to land on a real transient."""


def _decode_mono(
    path: str,
    ffmpeg: str,
    start_ms: float = 0.0,
    end_ms: float | None = None,
) -> "Any":
    """Decode to mono float32, optionally only a window of the file.

    The window matters: a reel is built against the part of the song the user
    kept, not the whole four-minute upload. Seeking before -i is the fast path
    and is accurate enough here, because everything downstream is quantised to
    onsets anyway. Returned times are relative to the window start.
    """
    import numpy as np

    trim: list[str] = []
    if start_ms > 0:
        trim += ["-ss", f"{start_ms / 1000:.3f}"]
    if end_ms is not None and end_ms > start_ms:
        trim += ["-t", f"{(end_ms - start_ms) / 1000:.3f}"]

    process = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
            *trim,
            "-i", path, "-vn", "-ac", "1", "-ar", str(ANALYSIS_RATE),
            "-f", "f32le", "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        message = process.stderr.decode("utf-8", "replace").strip()
        raise ValueError(message or "ffmpeg could not decode this audio")
    return np.frombuffer(process.stdout, dtype="<f4")


LOW_BAND_HZ = 150
"""Kick drums live below this; it is the most discriminative downbeat cue."""

ENERGY_TIERS = 4
"""Quiet / mid / high / peak, quantised over the track's own dynamic range."""


def _beat_sync(curve: "Any", beat_times: list[float], hop: int) -> "Any":
    """Average a frame-rate curve into one value per beat."""
    import numpy as np

    if not beat_times:
        return np.zeros(0)
    frames = [int(round(t * ANALYSIS_RATE / hop)) for t in beat_times]
    values = []
    for i, start in enumerate(frames):
        end = frames[i + 1] if i + 1 < len(frames) else curve.size
        lo = max(0, min(start, curve.size - 1))
        hi = max(lo + 1, min(end, curve.size))
        values.append(float(curve[lo:hi].mean()))
    return np.asarray(values)


def _normalise(values: "Any") -> "Any":
    """Scale to 0..1 over the track's own range, not absolute levels."""
    import numpy as np

    if values.size == 0:
        return values
    lo = float(np.percentile(values, 2))
    hi = float(np.percentile(values, 98))
    if hi - lo < 1e-9:
        return np.zeros_like(values)
    return np.clip((values - lo) / (hi - lo), 0.0, 1.0)


def _analyse_structure(
    samples: "Any",
    beat_times: list[float],
    downbeat_indices: list[int],
) -> dict[str, Any]:
    """Energy tiers, drops and build-ups.

    Built directly on librosa because the turnkey options are unavailable on
    this interpreter: allin1 and BeatNet both depend on madmom, and msaf is
    pinned against a librosa API that no longer exists. The parts actually
    needed here — where the energy jumps, where it climbs — are the cheap part
    of structure analysis. Semantic labelling ("this is a chorus") is the hard
    part, and nothing downstream needs it.
    """
    import librosa
    import numpy as np

    hop = 512
    if len(beat_times) < 8:
        return {"energy": [], "tiers": [], "drops": [], "buildups": [], "sections": []}

    spectrogram = np.abs(librosa.stft(samples, n_fft=2048, hop_length=hop))
    frequencies = librosa.fft_frequencies(sr=ANALYSIS_RATE, n_fft=2048)

    rms = librosa.feature.rms(S=spectrogram, frame_length=2048, hop_length=hop)[0]
    low_band = spectrogram[frequencies < LOW_BAND_HZ].sum(axis=0)
    centroid = librosa.feature.spectral_centroid(S=spectrogram, sr=ANALYSIS_RATE)[0]

    beat_rms = _normalise(_beat_sync(rms, beat_times, hop))
    beat_low = _normalise(_beat_sync(low_band, beat_times, hop))
    beat_centroid = _normalise(_beat_sync(centroid, beat_times, hop))

    # Tier over a smoothed curve: per-beat energy is too jittery to threshold.
    window = min(8, max(1, beat_rms.size // 8))
    smoothed = np.convolve(beat_rms, np.ones(window) / window, mode="same")
    tiers = np.clip((smoothed * ENERGY_TIERS).astype(int), 0, ENERGY_TIERS - 1)

    # --- drops ---------------------------------------------------------
    #
    # A drop is a downbeat where low-frequency energy jumps sharply AND the bars
    # before it are quiet. Requiring the quiet run-up is what separates a drop
    # from any loud passage — without it, every chorus scores.
    beats_per_bar = 4
    bar_seconds = (
        (beat_times[-1] - beat_times[0]) / max(1, len(beat_times) - 1) * beats_per_bar
        if len(beat_times) > 1
        else 2.0
    )

    # Asymmetric windows, on RAW energy.
    #
    # Two reasons, both learned the hard way:
    #  - Percentile normalisation destroys this signal. Low-band energy is
    #    near-silent between kicks and enormous on them, so a normalised curve
    #    has a mean near zero and no threshold works.
    #  - A symmetric window straddles the boundary: the bars BEFORE a drop score
    #    higher than the drop itself, because their forward window already
    #    contains it. Looking back further than forward fixes that.
    look_back = bar_seconds * 2
    look_forward = bar_seconds

    def window_mean(start_seconds: float, end_seconds: float) -> float:
        lo = int(round(max(0.0, start_seconds) * ANALYSIS_RATE / hop))
        hi = int(round(max(0.0, end_seconds) * ANALYSIS_RATE / hop))
        lo = max(0, min(lo, low_band.size - 1))
        hi = max(lo + 1, min(hi, low_band.size))
        return float(low_band[lo:hi].mean())

    track_mean_low = float(low_band.mean())
    candidates: list[dict[str, Any]] = []

    for index in downbeat_indices:
        if index >= len(beat_times):
            continue
        at = beat_times[index]
        if at < look_back or at + look_forward > beat_times[-1]:
            continue

        pre_mean = window_mean(at - look_back, at)
        post_mean = window_mean(at, at + look_forward)
        # A ratio, not a difference: raw energy has no fixed scale.
        ratio = (post_mean - pre_mean) / (pre_mean + 1e-6)

        # Quiet before, loud after — both judged against the track's own mean,
        # which is what distinguishes a drop from any other loud passage.
        quiet_before = pre_mean < track_mean_low
        loud_after = post_mean > track_mean_low

        if ratio > 2.0 and quiet_before and loud_after:
            candidates.append(
                {
                    "ms": int(round(at * 1000)),
                    "beatIndex": index,
                    "score": round(min(1.0, ratio / 10), 3),
                }
            )

    # Neighbouring bars can both qualify; keep the strongest of each cluster.
    candidates.sort(key=lambda d: d["score"], reverse=True)
    drops: list[dict[str, Any]] = []
    for candidate in candidates:
        if any(
            abs(candidate["beatIndex"] - kept["beatIndex"]) < beats_per_bar * 2 for kept in drops
        ):
            continue
        drops.append(candidate)
        if len(drops) >= 6:
            break
    drops.sort(key=lambda d: d["ms"])

    # --- build-ups -----------------------------------------------------
    #
    # The bars before a drop, if energy is climbing. A riser also sweeps upward
    # in pitch, so a rising spectral centroid corroborates it.
    buildups: list[dict[str, Any]] = []
    for drop in drops:
        index = drop["beatIndex"]
        start = max(0, index - beats_per_bar * 4)
        if index - start < 4:
            continue
        segment = beat_rms[start:index]
        centroid_segment = beat_centroid[start:index]
        x = np.arange(segment.size)
        rms_slope = float(np.polyfit(x, segment, 1)[0]) if segment.size > 1 else 0.0
        centroid_slope = (
            float(np.polyfit(x, centroid_segment, 1)[0]) if centroid_segment.size > 1 else 0.0
        )
        if rms_slope > 0.004 or centroid_slope > 0.004:
            buildups.append(
                {
                    "startMs": int(round(beat_times[start] * 1000)),
                    "endMs": drop["ms"],
                    "towardsMs": drop["ms"],
                    "rising": round(max(rms_slope, centroid_slope), 4),
                }
            )

    # --- sections ------------------------------------------------------
    sections: list[int] = []
    try:
        chroma = librosa.feature.chroma_cqt(y=samples, sr=ANALYSIS_RATE, hop_length=hop)
        synced = librosa.util.sync(
            chroma, [int(round(t * ANALYSIS_RATE / hop)) for t in beat_times], aggregate=np.median
        )
        if synced.shape[1] >= 8:
            recurrence = librosa.segment.recurrence_matrix(synced, mode="affinity", sym=True)
            enhanced = librosa.segment.path_enhance(recurrence, n=7)
            k = int(max(2, min(10, synced.shape[1] // 32)))
            boundaries = librosa.segment.agglomerative(enhanced, k)
            sections = [
                int(round(beat_times[min(int(b), len(beat_times) - 1)] * 1000)) for b in boundaries
            ]
    except Exception:
        # Section detection is a bonus; drops and tiers are what drive editing.
        sections = []

    return {
        "energy": [round(float(v), 3) for v in beat_rms],
        "tiers": [int(t) for t in tiers],
        "drops": [{"ms": d["ms"], "score": d["score"]} for d in drops],
        "buildups": buildups,
        "sections": sorted(set(sections)),
    }


def _downbeat_phase(samples: "Any", beats: list[float], onset_env: "Any") -> int:
    """Pick the beat offset (0-3) that best matches where bars start.

    Scores each candidate phase by the low-frequency energy at its beats. A
    tie-break on overall onset strength keeps it stable for music with no
    prominent kick.
    """
    import librosa
    import numpy as np

    if len(beats) < 8:
        return 0

    # Low-band energy over time, at the same hop as the onset envelope.
    spectrogram = np.abs(librosa.stft(samples, n_fft=2048, hop_length=512))
    frequencies = librosa.fft_frequencies(sr=ANALYSIS_RATE, n_fft=2048)
    low_band = spectrogram[frequencies < LOW_BAND_HZ].sum(axis=0)

    def sample(curve: "Any", seconds: float) -> float:
        frame = int(round(seconds * ANALYSIS_RATE / 512))
        if frame < 0 or frame >= curve.size:
            return 0.0
        # A small window: a snapped beat can sit a frame either side of the hit.
        lo = max(0, frame - 1)
        hi = min(curve.size, frame + 2)
        return float(curve[lo:hi].max())

    best_phase = 0
    best_score = -1.0
    for phase in range(4):
        candidates = beats[phase::4]
        if not candidates:
            continue
        low = float(np.mean([sample(low_band, t) for t in candidates]))
        onset = float(np.mean([sample(onset_env, t) for t in candidates]))
        # Low band dominates; onset strength only breaks ties.
        score = low + onset * 0.1
        if score > best_score:
            best_score = score
            best_phase = phase

    return best_phase


def register(server: Server) -> None:
    try:
        import librosa  # noqa: F401
        import numpy  # noqa: F401
    except ImportError as exc:
        raise Unavailable(f"librosa is not installed: {exc}") from exc

    def analyse(params: dict[str, Any], context: Context) -> dict[str, Any]:
        import librosa
        import numpy as np

        path = params.get("path")
        if not isinstance(path, str) or not os.path.isfile(path):
            raise ValueError(f"No such audio file: {path!r}")

        ffmpeg = params.get("ffmpeg")
        if not isinstance(ffmpeg, str):
            raise ValueError("Beat analysis needs the path to ffmpeg")

        start_ms = params.get("startMs")
        end_ms = params.get("endMs")
        start_ms = float(start_ms) if isinstance(start_ms, (int, float)) else 0.0
        end_ms = float(end_ms) if isinstance(end_ms, (int, float)) else None

        context.progress(None, "decoding")
        samples = _decode_mono(path, ffmpeg, start_ms, end_ms)
        if samples.size == 0:
            return {"bpm": 0.0, "beats": [], "downbeats": [], "onsets": [], "durationMs": 0}

        context.raise_if_cancelled()
        context.progress(0.35, "finding onsets")

        # Spectral flux: where energy rises sharply, i.e. transients.
        onset_env = librosa.onset.onset_strength(y=samples, sr=ANALYSIS_RATE)
        onset_frames = librosa.onset.onset_detect(
            onset_envelope=onset_env, sr=ANALYSIS_RATE, backtrack=True
        )
        onset_times = librosa.frames_to_time(onset_frames, sr=ANALYSIS_RATE)

        context.raise_if_cancelled()
        context.progress(0.7, "tracking beats")

        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=ANALYSIS_RATE, trim=False
        )
        beat_times = librosa.frames_to_time(beat_frames, sr=ANALYSIS_RATE)

        # The tracker gives metrical structure at frame resolution; onsets give
        # the sample-accurate transient. Neither alone is enough, so each beat is
        # nudged onto the nearest real onset when one is close by.
        snapped: list[float] = []
        tolerance = ONSET_SNAP_MS / 1000
        for beat in beat_times:
            if onset_times.size:
                nearest = onset_times[np.argmin(np.abs(onset_times - beat))]
                snapped.append(float(nearest) if abs(nearest - beat) <= tolerance else float(beat))
            else:
                snapped.append(float(beat))

        bpm = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0

        context.progress(0.85, "finding the downbeat")

        # Which beat is beat 1?
        #
        # librosa does not track metre, so downbeats have to be inferred — but
        # taking every fourth beat from index 0 assumes the tracker happened to
        # start on a downbeat, which it usually did not. Getting the phase wrong
        # puts every structural cut on beat 3, and everything downstream keys
        # off these.
        #
        # Kicks land on beat 1, so the phase whose beats carry the most
        # low-frequency energy is the downbeat phase.
        phase = _downbeat_phase(samples, snapped, onset_env)
        downbeats = snapped[phase::4]
        downbeat_indices = list(range(phase, len(snapped), 4))

        context.raise_if_cancelled()
        context.progress(0.9, "reading structure")
        structure = _analyse_structure(samples, snapped, downbeat_indices)

        context.progress(1.0, "done")
        return {
            "bpm": round(bpm, 2),
            "beats": [int(round(t * 1000)) for t in snapped],
            "downbeats": [int(round(t * 1000)) for t in downbeats],
            "onsets": [int(round(float(t) * 1000)) for t in onset_times],
            "durationMs": int(round(samples.size / ANALYSIS_RATE * 1000)),
            "backend": "librosa",
            "downbeatsInferred": True,
            "downbeatPhase": phase,
            # Every time above is relative to the window, not the file. The
            # caller knows where the window sits on the timeline; the analysis
            # deliberately does not.
            "windowStartMs": int(round(start_ms)),
            **structure,
        }

    server.register("audio.beats", analyse)
