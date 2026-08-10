#!/usr/bin/env python3
"""
spark_guard.py — PreToolUse hook for Spark runs.

`--disallowedTools` removes named tools from the session outright, which is
real enforcement. It cannot, however, describe Bash: a shell can send mail
through gmail_helper, reach a client server over SSH, or push a commit, none of
which have a tool name to deny. This hook closes that gap.

Reads the hook payload on stdin, exits 0 to allow, exits 2 with a reason on
stderr to deny (the model sees the reason and moves on).

Two rules, both deliberately blunt:
  * Bash commands matching an outbound/remote/destructive pattern are denied.
    Spark drafts; a human clicks send. Spark reports; a session does the work.
  * Write/Edit outside the run directory (and the handoffs directory) is denied,
    so a run cannot rewrite the repo it is reporting on.

Every denial is appended to <run-dir>/guard.log so a model probing a boundary
is visible rather than silent.

Usage (wired via --settings, written per run by spark.js):
    spark_guard.py --run-dir /path/to/run
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

HOME = Path.home()

# (label, pattern). Patterns are matched case-insensitively against the whole
# command string. `(?:^|[;&|(]\s*)` anchors to a command position so a mention
# inside a filename or a grep pattern does not trip the rule.
CMD = r"(?:^|[;&|(]\s*)\s*"

BASH_DENY = [
    # Outbound mail. Spark creates drafts; the dashboard sends, after a human
    # confirms the exact text.
    ("sends email", r"send_email|smtplib|sendmail|\bmsmtp\b|" + CMD + r"mail\s+-s|messages\(\)\.send"),
    # Remote systems and client infrastructure — these need a pre-work snapshot
    # and belong in a real session.
    ("touches a remote system", CMD + r"(ssh|scp|rsync|lsailr|sftp)\b"),
    ("touches client infrastructure", CMD + r"(wp|aws|wrangler|certbot|doctl|gcloud)\b"),
    # Flags may sit between the command and the verb (`systemctl --user restart`).
    ("changes a service", CMD + r"systemctl\s+(?:-{1,2}\S+\s+)*(start|stop|restart|reload|enable|disable|kill)\b"),
    # Version control writes.
    ("writes to version control", r"\bgit\s+(commit|push|reset|checkout|clean|rebase|merge|tag)\b|\bgh\s+(pr|release)\b"),
    # Destructive local operations.
    ("deletes or overwrites files", CMD + r"(rm|mv|shred|truncate|dd|mkfs)\b"),
    # Calendar and money.
    ("creates a calendar event", r"calendar_create_event|calendar_update_event|calendar_delete_event"),
    ("touches billing", r"\bsquare_(create|update|publish|cancel)|invoices?\.(create|publish)"),
]

WRITE_TOOLS = {"Write", "Edit", "NotebookEdit", "MultiEdit"}


def denied_reason(tool_name: str, tool_input: dict, run_dir: Path) -> str | None:
    if tool_name == "Bash":
        command = (tool_input.get("command") or "")
        for label, pattern in BASH_DENY:
            if re.search(pattern, command, re.IGNORECASE):
                return (
                    f"Spark may not run a command that {label}. "
                    "Propose it as an action for a human to approve instead — "
                    'tier "handoff" for anything on a server or in git. Sending '
                    "mail is not proposable at all: leave a Gmail draft instead."
                )
        return None

    if tool_name in WRITE_TOOLS:
        raw = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        if not raw:
            return None
        try:
            target = Path(os.path.expanduser(raw)).resolve()
        except OSError:
            return f"Spark could not resolve the write path {raw!r}."
        allowed = [run_dir.resolve(), (HOME / "OpenDia" / "handoffs").resolve()]
        if not any(target == root or root in target.parents for root in allowed):
            return (
                f"Spark may only write inside its own run directory ({run_dir}) "
                f"or ~/OpenDia/handoffs. Refusing to write {target}."
            )
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    args = ap.parse_args()
    run_dir = Path(args.run_dir)

    try:
        payload = json.load(sys.stdin)
    except Exception:
        # A guard that cannot read its input must not silently allow everything.
        print("spark guard could not parse the hook payload — denying.", file=sys.stderr)
        sys.exit(2)

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}

    reason = denied_reason(tool_name, tool_input, run_dir)
    if not reason:
        sys.exit(0)

    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        with (run_dir / "guard.log").open("a") as fh:
            fh.write(json.dumps({
                "tool": tool_name,
                "reason": reason,
                "input": {k: str(v)[:400] for k, v in tool_input.items()},
            }) + "\n")
    except OSError:
        pass

    print(reason, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
