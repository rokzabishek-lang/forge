"""JSON-RPC 2.0 over stdio, newline-delimited.

Framing and dispatch only — capabilities live in ``forge_sidecar.capabilities``.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

PROTOCOL_VERSION = 1

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
CANCELLED = -32800
UNAVAILABLE = -32001


class Cancelled(Exception):
    """Raised inside a handler when the client cancels the request."""


class Unavailable(Exception):
    """A capability exists but cannot run — missing model or dependency."""


@dataclass
class Context:
    """Handed to every handler: progress reporting and cancellation."""

    request_id: int
    _server: "Server"
    _cancelled: threading.Event = field(default_factory=threading.Event)

    def cancel(self) -> None:
        self._cancelled.set()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def raise_if_cancelled(self) -> None:
        """Call inside long loops. Cancellation is cooperative — a handler that
        never checks cannot be interrupted, because killing a thread mid-work
        would leave models and file handles in an undefined state."""
        if self._cancelled.is_set():
            raise Cancelled()

    def progress(self, progress: float | None, message: str | None = None) -> None:
        params: dict[str, Any] = {"id": self.request_id, "progress": progress}
        if message is not None:
            params["message"] = message
        self._server.notify("progress", params)


Handler = Callable[[dict[str, Any], Context], Any]


class Server:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}
        self._degraded: dict[str, str] = {}
        self._active: dict[int, Context] = {}
        self._threads: set[threading.Thread] = set()
        self._write_lock = threading.Lock()

    # ---------------------------------------------------------- registration

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def mark_degraded(self, method: str, reason: str) -> None:
        """Record a capability that loaded but cannot run, so `system.hello`
        can report *why* rather than the method simply being absent."""
        self._degraded[method] = reason

    @property
    def capabilities(self) -> list[str]:
        return sorted(self._handlers)

    @property
    def degraded(self) -> dict[str, str]:
        return dict(self._degraded)

    # --------------------------------------------------------------- writing

    def _write(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        with self._write_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def notify(self, method: str, params: Any) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond(self, request_id: int, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _fail(self, request_id: int, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write({"jsonrpc": "2.0", "id": request_id, "error": error})

    # ------------------------------------------------------------ dispatch

    def _run(self, request_id: int, method: str, params: dict[str, Any]) -> None:
        context = self._active[request_id]
        try:
            handler = self._handlers[method]
            self._respond(request_id, handler(params, context))
        except Cancelled:
            self._fail(request_id, CANCELLED, "Cancelled")
        except Unavailable as exc:
            self._fail(request_id, UNAVAILABLE, str(exc))
        except Exception as exc:  # noqa: BLE001 - the boundary must not leak
            self._fail(request_id, INTERNAL_ERROR, str(exc), traceback.format_exc())
        finally:
            self._active.pop(request_id, None)
            self._threads.discard(threading.current_thread())

    def _handle(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        request_id = message.get("id")

        # Notifications carry no id and get no response.
        if request_id is None:
            if method == "cancel":
                target = (message.get("params") or {}).get("id")
                context = self._active.get(target)
                if context is not None:
                    context.cancel()
            return

        if not isinstance(method, str):
            self._fail(request_id, INVALID_REQUEST, "Missing method")
            return
        if method not in self._handlers:
            reason = self._degraded.get(method)
            if reason:
                self._fail(request_id, UNAVAILABLE, reason)
            else:
                self._fail(request_id, METHOD_NOT_FOUND, f"Unknown method: {method}")
            return

        params = message.get("params") or {}
        if not isinstance(params, dict):
            self._fail(request_id, INVALID_PARAMS, "params must be an object")
            return

        context = Context(request_id=request_id, _server=self)
        self._active[request_id] = context

        # Each request runs on its own thread so a long transcription does not
        # block the read loop — cancel notifications must still arrive.
        thread = threading.Thread(
            target=self._run, args=(request_id, method, params), daemon=True
        )
        self._threads.add(thread)
        thread.start()

    # ------------------------------------------------------------ main loop

    def serve_forever(self, drain_timeout: float = 300.0) -> None:
        """Read until stdin closes, then let in-flight work finish.

        Handlers run on daemon threads, so returning immediately on EOF would
        destroy them mid-request and the client would never see a response. A
        fast handler hides this; a slow one (transcription) does not.
        """
        try:
            self._read_loop()
        finally:
            self._drain(drain_timeout)

    def _drain(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        for thread in list(self._threads):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(timeout=remaining)

    def _read_loop(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._write(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": PARSE_ERROR, "message": "Parse error"}}
                )
                continue
            if isinstance(message, dict):
                self._handle(message)
