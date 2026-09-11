"""Capability registration.

A capability that cannot run must degrade itself, never take the sidecar down.
Both the import *and* the registration are guarded: a module can import fine and
still fail at register time when its heavy dependency is missing.
"""

from __future__ import annotations

from typing import Callable

from ..rpc import Server

# (method name reported when unavailable, module name)
OPTIONAL = [("asr.transcribe", "asr")]


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
