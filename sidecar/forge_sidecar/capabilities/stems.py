"""Real source separation, when it is installed.

The app can already split a song without this. `src/main/stems.ts` does it with
mid/side and the bundled ffmpeg: the instrumental is L−R, which cancels anything
mixed dead centre, and it is genuinely good — measured at 29dB of rejection on
the centred part with the panned parts untouched.

What mid/side cannot do is the other direction. Taking the mid signal keeps the
voice at full level but also keeps every hard-panned instrument at half of
theirs, so the result is a voice EMPHASIS rather than a voice. That is enough to
transcribe against and not enough to listen to.

Demucs does the real thing, and costs torch to do it — several hundred megabytes
for one feature. So it is optional, it degrades to a clear message rather than
taking the sidecar down, and the caller is told which backend answered:

    quality "separated"  a real stem, from this module
    quality "emphasised" mid/side, from the main process

Everything downstream reads the flag rather than assuming.

Install with:  pip install -r sidecar/requirements-stems.txt
"""

from __future__ import annotations

import hashlib
import os
import threading
from typing import Any

from ..rpc import Context, Server, Unavailable

# Lazily, and once: the model is ~80MB on top of torch, and loading it at import
# time would stall sidecar startup for a capability most sessions never use.
_lock = threading.Lock()
_separator: Any = None

DEFAULT_MODEL = "htdemucs"

# Demucs splits into four; everything that is not the voice is the instrumental.
VOICE_STEM = "vocals"


def _cache_dir(out_dir: str | None) -> str:
    if out_dir:
        return out_dir
    return os.path.join(os.path.expanduser("~"), ".cache", "forge", "stems")


def _key(path: str) -> str:
    info = os.stat(path)
    raw = f"{path}:{info.st_size}:{int(info.st_mtime)}:{DEFAULT_MODEL}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _load(model: str) -> Any:
    from demucs.api import Separator

    global _separator
    with _lock:
        if _separator is None:
            _separator = Separator(model=model)
        return _separator


def register(server: Server) -> None:
    try:
        import demucs.api  # noqa: F401
    except ImportError as exc:
        raise Unavailable(f"demucs is not installed: {exc}") from exc

    def stems(params: dict[str, Any], context: Context) -> dict[str, Any]:
        path = params.get("path")
        if not isinstance(path, str) or not os.path.isfile(path):
            raise ValueError(f"No such audio file: {path!r}")

        out_dir = params.get("outDir") if isinstance(params.get("outDir"), str) else None
        directory = _cache_dir(out_dir)
        os.makedirs(directory, exist_ok=True)

        key = _key(path)
        voice_path = os.path.join(directory, f"{key}.voice.wav")
        instrumental_path = os.path.join(directory, f"{key}.instrumental.wav")

        # Separation is minutes of work on CPU. Doing it twice for one song is
        # the difference between a feature and a thing nobody waits for.
        if os.path.isfile(voice_path) and os.path.isfile(instrumental_path):
            context.progress(1.0, "already separated")
            return {
                "voice": voice_path,
                "instrumental": instrumental_path,
                "backend": f"demucs/{DEFAULT_MODEL}",
                "quality": "separated",
            }

        model = params.get("model") or DEFAULT_MODEL
        context.progress(None, f"loading {model}")
        separator = _load(model)
        context.raise_if_cancelled()

        context.progress(None, "separating")
        _origin, separated = separator.separate_audio_file(path)
        context.raise_if_cancelled()

        from demucs.api import save_audio

        if VOICE_STEM not in separated:
            raise ValueError(f"{model} produced no {VOICE_STEM} stem")

        voice = separated[VOICE_STEM]
        # Everything that is not the voice, summed. Demucs's stems are additive
        # by construction, so this reconstructs the backing track exactly rather
        # than approximating it.
        instrumental = None
        for name, tensor in separated.items():
            if name == VOICE_STEM:
                continue
            instrumental = tensor if instrumental is None else instrumental + tensor
        if instrumental is None:
            raise ValueError(f"{model} produced only a {VOICE_STEM} stem")

        context.progress(0.9, "writing")
        save_audio(voice, voice_path, samplerate=separator.samplerate)
        save_audio(instrumental, instrumental_path, samplerate=separator.samplerate)

        context.progress(1.0, "done")
        return {
            "voice": voice_path,
            "instrumental": instrumental_path,
            "backend": f"demucs/{model}",
            "quality": "separated",
        }

    server.register("audio.stems", stems)
