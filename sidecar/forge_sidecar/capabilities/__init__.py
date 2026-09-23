"""Capability registration.

A capability that cannot run must degrade itself, never take the sidecar down.
Both the import *and* the registration are guarded: a module can import fine and
still fail at register time when its heavy dependency is missing.
"""

from __future__ import annotations

from typing import Callable

from ..rpc import Server

# (method name reported when unavailable, module name)
OPTIONAL = [
    ("asr.transcribe", "asr"),
    ("audio.beats", "beats"),
    ("depth.layers", "depth"),
    # Sharpness, exposure and near-duplicates, for the Director's quality gate
    # (docs/PLAN.md §4.2). numpy and scipy only; absent, the gate lets every
    # photo through rather than the Director failing.
    ("vision.measure", "vision"),
    # Optional in the strongest sense: the app can already split a song with
    # mid/side and the bundled ffmpeg, so this being absent costs quality
    # rather than the feature. See stems.py.
    ("audio.stems", "stems"),
    # Speech, the local half. Absent, the app uses whatever hosted endpoint the
    # user configured — see src/shared/voice/provider.ts.
    ("voice.speak", "voice"),
]


def register_all(server: Server) -> None:
    from . import system

    system.register(server)

    for method, module_name in OPTIONAL:
        try:
            module = __import__(f"{__name__}.{module_name}", fromlist=["register"])
            register: Callable[[Server], None] = module.register
            register(server)
        except Exception as exc:  # noqa: BLE001 - degrade, never crash
            server.mark_degraded(method, f"{module_name} unavailable: {exc}")
