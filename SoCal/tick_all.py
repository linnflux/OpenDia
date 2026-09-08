#!/usr/bin/env python3
"""Tick every registered SoCal client.

Runs publish.py tick for each client in the registry
(~/OpenDia/socal-clients.json) that has a Meta page id, so a new API client is
covered the moment onboarding registers it and its Config carries the Meta ids
— no per-client timer wiring, no forgotten wrappers (the FCB launch nearly
shipped without one). The systemd timer calls this instead of a single
client's tick script.

Failures are isolated per client: one client's bad tick never blocks another
client's publishes. Per-client output appends to
~/OpenDia/clients/<slug>/social/tick.log, same file the old per-client
wrappers used, so existing log-watching habits keep working.
"""
import datetime
import json
import os
import subprocess
import sys

REGISTRY = os.path.expanduser("~/OpenDia/socal-clients.json")
PUBLISH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "publish.py")


def main():
    with open(REGISTRY) as fh:
        clients = json.load(fh)
    failures = []
    for c in clients:
        if not c.get("page_id"):
            continue  # no Meta access yet — nothing to tick
        slug = c["slug"]
        logdir = os.path.expanduser(f"~/OpenDia/clients/{slug}/social")
        os.makedirs(logdir, exist_ok=True)
        with open(os.path.join(logdir, "tick.log"), "a") as fh:
            fh.write(f"--- tick {datetime.datetime.now().astimezone().isoformat()}\n")
            fh.flush()
            rc = subprocess.run([sys.executable, PUBLISH, "--sheet", c["sheet"], "tick"],
                                stdout=fh, stderr=subprocess.STDOUT).returncode
        if rc != 0:
            failures.append(slug)
    if failures:
        sys.exit("tick failed for: " + ", ".join(failures))


if __name__ == "__main__":
    main()
