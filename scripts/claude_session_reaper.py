#!/usr/bin/env python3
"""Reap idle interactive Claude Code TUI sessions to reclaim memory.

Each interactive Claude session holds ~450MB plus ~350MB of stdio MCP child
processes. Conversations are written incrementally to a transcript jsonl, so
killing the TUI loses nothing — `claude --resume <session-name>` restores the
full history on demand.

A session is reaped when ALL of:
  - its ~/.claude/sessions/<pid>.json says kind == "interactive"
  - idle age (now - updatedAt on the session json) > threshold (default 72h)
  - status is not busy/shell (not actively working)
  - no active timer state file references its name as tmux_session
  - its tmux session (same name) is not currently attached
  - its name is not pinned in the keep file

Usage:
  claude_session_reaper.py [--dry-run] [--threshold-hours N] [--kill-tmux]
  claude_session_reaper.py --only NAME   # reap one named session now
                                         # (ignores idle age, keeps other guards)
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HOME = Path.home()
SESSIONS_DIR = HOME / ".claude" / "sessions"
PROJECTS_DIR = HOME / ".claude" / "projects"
TIMER_GLOB = HOME / "OpenDia" / "Time"
KEEP_FILE = HOME / "OpenDia" / ".reaper-keep"
TZ = ZoneInfo("America/New_York")

DEFAULT_THRESHOLD_H = 72
SIGTERM_GRACE_S = 15


def now_stamp():
    return datetime.now(TZ).strftime("%Y-%m-%dT%H:%M")


def proc_starttime(pid):
    """starttime (field 22) from /proc/<pid>/stat; comm may contain spaces."""
    try:
        stat = (Path("/proc") / str(pid) / "stat").read_text()
        fields = stat[stat.rindex(")") + 2:].split()
        return fields[19]  # field 22 overall; 20th after comm/state
    except (OSError, ValueError, IndexError):
        return None


def proc_is_claude(pid):
    try:
        cmdline = (Path("/proc") / str(pid) / "cmdline").read_bytes()
        return b"claude" in cmdline
    except OSError:
        return False


def ancestor_pids():
    """Our own process ancestry — never reap a session we're running inside."""
    pids, pid = set(), os.getpid()
    while pid > 1:
        pids.add(pid)
        try:
            stat = (Path("/proc") / str(pid) / "stat").read_text()
            pid = int(stat[stat.rindex(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return pids


def transcript_path(cwd, session_id):
    slug = cwd.replace("/", "-").replace(".", "-").replace("_", "-")
    return PROJECTS_DIR / slug / f"{session_id}.jsonl"


def timer_protected_names():
    names = set()
    for f in TIMER_GLOB.glob(".timer-*.json"):
        try:
            name = json.loads(f.read_text()).get("tmux_session", "")
            if name:
                names.add(name)
        except (OSError, json.JSONDecodeError):
            pass
    return names


def tmux_sessions():
    """{name: attached_bool} for all live tmux sessions."""
    try:
        out = subprocess.run(
            ["tmux", "ls", "-F", "#{session_name}|#{session_attached}"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    sessions = {}
    for line in out.stdout.splitlines():
        if "|" in line:
            name, attached = line.rsplit("|", 1)
            sessions[name] = attached.strip() not in ("", "0")
    return sessions


def keep_names():
    try:
        return {l.strip() for l in KEEP_FILE.read_text().splitlines()
                if l.strip() and not l.startswith("#")}
    except OSError:
        return set()


def reap(pid):
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + SIGTERM_GRACE_S
    while time.time() < deadline:
        if not (Path("/proc") / str(pid)).exists():
            return "sigterm"
        time.sleep(0.5)
    os.kill(pid, signal.SIGKILL)
    time.sleep(1)
    return "sigkill"


def leave_breadcrumb(name, idle_h, live_tmux):
    if name not in live_tmux:
        return
    msg = f"echo '# claude session reaped after {idle_h:.0f}h idle — resume: claude --resume {name}'"
    subprocess.run(["tmux", "send-keys", "-t", name, msg, "Enter"],
                   capture_output=True, timeout=10)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--threshold-hours", type=float, default=DEFAULT_THRESHOLD_H)
    ap.add_argument("--kill-tmux", action="store_true",
                    help="also kill the tmux session after reaping (default: keep it with a resume hint)")
    ap.add_argument("--only", metavar="NAME",
                    help="reap only this named session, regardless of idle age (busy/timer/attached/pinned guards still apply)")
    args = ap.parse_args()

    threshold_s = args.threshold_hours * 3600
    now_ms = time.time() * 1000
    protected = timer_protected_names()
    live_tmux = tmux_sessions()
    pinned = keep_names()
    ancestors = ancestor_pids()

    reaped, skipped, hung = [], {}, []

    def skip(reason):
        skipped[reason] = skipped.get(reason, 0) + 1

    for f in sorted(SESSIONS_DIR.glob("*.json")):
        try:
            meta = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            skip("unreadable")
            continue

        pid = meta.get("pid")
        name = meta.get("name") or f"pid-{pid}"

        if args.only and name != args.only:
            skip("not-target")
            continue
        if not pid or not (Path("/proc") / str(pid)).exists():
            skip("dead-pid")
            continue
        if not proc_is_claude(pid) or proc_starttime(pid) != str(meta.get("procStart", "")):
            skip("pid-recycled")
            continue
        if meta.get("kind") != "interactive":
            skip("not-interactive")
            continue
        if pid in ancestors:
            skip("self")
            continue

        # Idle = time since the session's own last interaction (updatedAt on the
        # sessions/<pid>.json, bumped on real user activity + status changes).
        # We deliberately do NOT fold in the transcript-file mtime: background
        # pings touch every session's transcript ~hourly, so max(updatedAt,
        # transcript_mtime) made every session look ~1h idle and the reaper never
        # fired (38 sessions, 3-18 days idle, all read as "fresh" — the OOM this
        # tool exists to prevent). The busy/shell status guard below still
        # protects sessions that are actively working right now.
        updated_ms = meta.get("updatedAt") or meta.get("startedAt") or 0
        idle_s = (now_ms - updated_ms) / 1000
        idle_h = idle_s / 3600

        if idle_s <= threshold_s and not args.only:
            skip("fresh")
            continue
        if meta.get("status") in ("busy", "shell"):
            skip("busy")
            hung.append(f"{name} (pid {pid}, {meta.get('status')} for {idle_h:.0f}h)")
            continue
        if name in protected:
            skip("active-timer")
            continue
        if live_tmux.get(name):
            skip("tmux-attached")
            continue
        if name in pinned:
            skip("pinned")
            continue

        if args.dry_run:
            reaped.append(f"{name} (pid {pid}, idle {idle_h:.0f}h) [dry-run]")
            continue

        try:
            how = reap(pid)
        except (OSError, ProcessLookupError) as e:
            reaped.append(f"{name} (pid {pid}) FAILED: {e}")
            continue
        if args.kill_tmux and name in live_tmux:
            subprocess.run(["tmux", "kill-session", "-t", name],
                           capture_output=True, timeout=10)
        else:
            leave_breadcrumb(name, idle_h, live_tmux)
        reaped.append(f"{name} (pid {pid}, idle {idle_h:.0f}h, {how})")

    mode = " DRY-RUN" if args.dry_run else ""
    skip_str = " ".join(f"{k}={v}" for k, v in sorted(skipped.items())) or "none"
    print(f"[{now_stamp()}]{mode} reaped={len(reaped)} skipped: {skip_str}")
    for r in reaped:
        print(f"  reaped: {r}")
    for h in hung:
        print(f"  POSSIBLY-HUNG: {h}")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
