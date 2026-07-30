#!/usr/bin/env python3
"""opendia_config.py — deployment-specific resource IDs, kept out of source.

WHY THIS EXISTS

This repository is public. Spreadsheet IDs, Notion database IDs, and workspace
IDs are not secrets — they are useless without credentials — but they are
durable pointers at live business data. Committing them means that if a sheet is
ever set to "anyone with the link", the address is already published and
indexed. They also make the repo un-forkable: anyone cloning it inherits
someone else's resource IDs baked into the source.

So they live in ~/OpenDia/.opendia.conf (chmod 600, outside the repo) or in the
environment, and are read through here.

RESOLUTION ORDER
    1. environment variable of the same name  (wins — handy for one-off runs
       and for CI, where writing a conf file is awkward)
    2. ~/OpenDia/.opendia.conf                (KEY=value, # comments allowed)
    3. the `default` argument, if given
    4. RuntimeError naming the key and how to set it

Usage:
    from opendia_config import get_id
    BILLING_OPS_SHEET_ID = get_id("BILLING_OPS_SHEET_ID")
    TAB = get_id("BILLING_TAB", default="Clients")

Failing loudly on a missing ID is deliberate. A silently-wrong resource ID
writes billing data into the wrong spreadsheet, which is far worse than a
crash on startup.
"""

import os
from pathlib import Path

CONF_PATH = Path.home() / "OpenDia" / ".opendia.conf"

_cache = None


def _load_conf():
    """Parse the conf file once per process. Missing file is not an error —
    a deployment may configure everything through the environment instead."""
    global _cache
    if _cache is not None:
        return _cache
    conf = {}
    try:
        for line in CONF_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            conf[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    _cache = conf
    return conf


def get_id(key, default=None, required=True):
    """Resolve one deployment-specific value. See module docstring for order."""
    val = os.environ.get(key) or _load_conf().get(key)
    if val:
        return val
    if default is not None:
        return default
    if not required:
        return None
    raise RuntimeError(
        f"{key} is not configured.\n"
        f"  Set it in {CONF_PATH} as:  {key}=<value>\n"
        f"  or export {key} in the environment.\n"
        f"  See examples/opendia.conf.example in the repo for the full list."
    )


if __name__ == "__main__":
    # Diagnostic: show what resolves, without printing full values.
    keys = [
        "BILLING_OPS_SHEET_ID",
        "BILLING_MASTER_SHEET_ID",
        "NOTION_TASKS_DB_ID",
        "NOTION_BUILD_REGISTRY_ID",
        "TOGGL_WORKSPACE_ID",
    ]
    print(f"conf: {CONF_PATH} ({'found' if CONF_PATH.exists() else 'MISSING'})")
    for k in keys:
        v = get_id(k, required=False)
        src = "env" if os.environ.get(k) else ("conf" if v else "-")
        shown = f"{v[:6]}…{v[-4:]}" if v and len(v) > 12 else (v or "NOT SET")
        print(f"  {k:28} {shown:20} [{src}]")
