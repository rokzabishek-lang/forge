"""Speech recognition with word-level timestamps.

Uses faster-whisper (CTranslate2). Whisper covers every language including the
Indic set, which Parakeet does not — see docs/STACK.md §2. Parakeet-TDT is the
better European-language option (native transducer timestamps, ±20-40ms vs
Whisper's ±100-300ms DTW) and slots in beside this as a second tier.
"""

from __future__ import annotations

import os
import threading
from typing import Any

from ..rpc import Context, Server, Unavailable

# Imported lazily: the model is ~240MB and loading it at import time would
# stall sidecar startup and download on first launch rather than first use.
_model_lock = threading.Lock()
_models: dict[tuple[str, str], Any] = {}

DEFAULT_MODEL = "small"


def _models_dir() -> str:
    override = os.environ.get("FORGE_MODELS_DIR")
    if override:
        return override
    return os.path.join(
        os.path.expanduser("~"), ".cache", "forge", "models"
    )


def _load_model(size: str, compute_type: str) -> Any:
    from faster_whisper import WhisperModel

    key = (size, compute_type)
    with _model_lock:
        if key not in _models:
            _models[key] = WhisperModel(
                size,
                device="cpu",
                compute_type=compute_type,
                download_root=_models_dir(),
            )
        return _models[key]


def register(server: Server) -> None:
    try:
        import faster_whisper  # noqa: F401
    except ImportError as exc:
        raise Unavailable(f"faster-whisper is not installed: {exc}") from exc

    def transcribe(params: dict[str, Any], context: Context) -> dict[str, Any]:
        path = params.get("path")
        if not isinstance(path, str) or not os.path.isfile(path):
            raise ValueError(f"No such media file: {path!r}")

        size = params.get("model") or DEFAULT_MODEL
        language = params.get("language") or None
        # int8 is 2-4x faster on CPU with negligible quality loss for captions.
        compute_type = params.get("computeType") or "int8"

        context.progress(None, f"loading {size}")
        model = _load_model(size, compute_type)
        context.raise_if_cancelled()

        context.progress(None, "analysing audio")
        segments_iter, info = model.transcribe(
            path,
            language=language,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
        )

        duration = float(info.duration or 0.0)
        words: list[dict[str, Any]] = []
        index = 0

        for segment in segments_iter:
            # Cancellation is cooperative; this is the checkpoint. Whisper
            # yields lazily, so the loop is where the real work happens.
            context.raise_if_cancelled()

            for word in segment.words or []:
                text = word.word.strip()
                if not text:
                    continue
                words.append(
                    {
                        "index": index,
                        "text": text,
                        "startMs": int(round(word.start * 1000)),
                        "endMs": int(round(word.end * 1000)),
                        "confidence": (
                            round(float(word.probability), 4)
                            if word.probability is not None
                            else None
                        ),
                    }
                )
                index += 1

            if duration > 0:
                context.progress(min(1.0, segment.end / duration))

        context.progress(1.0, "done")
        return {
            "language": info.language,
            "languageProbability": round(float(info.language_probability or 0), 4),
            "durationMs": int(round(duration * 1000)),
            "model": f"faster-whisper/{size}/{compute_type}",
            "words": words,
        }

    server.register("asr.transcribe", transcribe)
