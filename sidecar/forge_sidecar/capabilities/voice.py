"""Kokoro-82M, through ONNX Runtime.

The local half of the voice provider pair (src/shared/voice/provider.ts). No
network, no key, no per-use cost — which is what "fully local" has meant in this
project from the start.

Two things make Kokoro the right local choice here rather than a bigger model.
It is 82M parameters, so it synthesises faster than real time on a laptop CPU;
and it has an ONNX build, so it runs on the runtime the depth model already
brought with it. That matters more than it sounds: the alternative TTS models
all want torch, and torch is several hundred megabytes for one feature. This
costs a model file.

Optional all the same, and degraded cleanly when absent — the app falls back to
whatever hosted endpoint the user configured, and says which one answered.

Install with:  pip install -r sidecar/requirements-voice.txt
"""

from __future__ import annotations

import os
import threading
import wave
from typing import Any

from ..rpc import Context, Server, Unavailable

_lock = threading.Lock()
_engine: Any = None

# Kokoro's own output rate. Resampling here would only cost a pass; the app
# imports the file as an ordinary asset and ffmpeg handles the rest.
SAMPLE_RATE = 24_000
DEFAULT_VOICE = "af_heart"


def _models_dir() -> str:
    override = os.environ.get("FORGE_MODELS_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".cache", "forge", "models")


def _load() -> Any:
    """The engine, once.

    kokoro-onnx wants the model and the voice pack as two files. Both are
    fetched on first use rather than bundled, the same way the depth model is.
    """
    from kokoro_onnx import Kokoro

    global _engine
    with _lock:
        if _engine is None:
            directory = _models_dir()
            model = os.path.join(directory, "kokoro-v1.0.onnx")
            voices = os.path.join(directory, "voices-v1.0.bin")
            missing = [p for p in (model, voices) if not os.path.isfile(p)]
            if missing:
                names = ", ".join(os.path.basename(p) for p in missing)
                raise Unavailable(
                    f"Kokoro's model files are not downloaded yet ({names}). "
                    f"Put them in {directory}."
                )
            _engine = Kokoro(model, voices)
        return _engine


def _write_wav(path: str, samples: Any, rate: int) -> int:
    """Float samples to a 16-bit wav, and its length in ms.

    Written here rather than handed back over the wire: audio is large, the
    caller wants a file on disk to import as an asset anyway, and shipping a
    megabyte of floats through a JSON-RPC pipe to write it at the other end
    would be slower and no clearer.
    """
    import numpy as np

    array = np.asarray(samples, dtype="float32").reshape(-1)
    # Clipping rather than normalising: a voice that quietly changes level
    # between sentences is worse than one that occasionally touches the rails,
    # and the joins in narration are sentence boundaries.
    clipped = np.clip(array, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())

    return int(round(len(array) / max(1, rate) * 1000))


def register(server: Server) -> None:
    try:
        import kokoro_onnx  # noqa: F401
    except ImportError as exc:
        raise Unavailable(f"kokoro-onnx is not installed: {exc}") from exc

    def voices(_params: dict[str, Any], _context: Context) -> dict[str, Any]:
        engine = _load()
        names = sorted(getattr(engine, "get_voices", lambda: [])())
        return {
            "voices": [
                {"id": name, "label": _label(name), "language": _language(name)}
                for name in names
            ]
        }

    def speak(params: dict[str, Any], context: Context) -> dict[str, Any]:
        text = params.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Nothing to say")

        out = params.get("out")
        if not isinstance(out, str) or not out:
            raise ValueError("Speaking needs somewhere to write the audio")

        voice = params.get("voice") or DEFAULT_VOICE
        speed = params.get("speed")
        rate = float(speed) if isinstance(speed, (int, float)) else 1.0
        rate = min(2.0, max(0.5, rate))

        context.progress(None, "loading the voice")
        engine = _load()
        context.raise_if_cancelled()

        context.progress(None, "speaking")
        samples, sample_rate = engine.create(text, voice=voice, speed=rate, lang="en-us")
        context.raise_if_cancelled()

        duration = _write_wav(out, samples, int(sample_rate or SAMPLE_RATE))
        context.progress(1.0, "done")
        return {
            "path": out,
            "durationMs": duration,
            "voice": voice,
            "provider": "kokoro",
            "model": "kokoro-v1.0",
        }

    server.register("voice.speak", speak)
    server.register("voice.voices", voices)


def _language(name: str) -> str:
    """Kokoro encodes the language in the voice id's first letter."""
    return {
        "a": "en-US",
        "b": "en-GB",
        "e": "es",
        "f": "fr",
        "h": "hi",
        "i": "it",
        "j": "ja",
        "p": "pt-BR",
        "z": "zh",
    }.get(name[:1], "en-US")


def _label(name: str) -> str:
    """`af_heart` reads as "Heart". The prefix is metadata, not a name."""
    parts = name.split("_", 1)
    return parts[1].replace("_", " ").title() if len(parts) > 1 else name
