"""Entry point: python -m forge_sidecar"""

from __future__ import annotations

import sys

from .capabilities import register_all
from .rpc import Server


def main() -> int:
    # Anything a library prints to stdout would corrupt the JSON-RPC stream, so
    # stdout is reserved for protocol traffic and everything else goes to stderr.
    sys.stdout.reconfigure(line_buffering=True)

    server = Server()
    register_all(server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
