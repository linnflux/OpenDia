"""Crash injection for the durability tests. A no-op unless OPENDIA_FAILPOINT is set."""

import os


def hit(name: str) -> None:
    if os.environ.get("OPENDIA_FAILPOINT") == name:
        os._exit(137)  # simulate kill -9: no cleanup, no checkpoint
