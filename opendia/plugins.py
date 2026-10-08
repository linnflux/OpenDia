"""Load user-supplied classes named as "package.module:Class"."""

from __future__ import annotations

import importlib


def load_object(spec: str):
    if ":" not in spec:
        raise ValueError(f"Unknown kind {spec!r}; expected a built-in name or 'package.module:Class'")
    module, _, attr = spec.partition(":")
    return getattr(importlib.import_module(module), attr)
