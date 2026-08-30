#!/usr/bin/env python3
"""
claude_usage.py — Retro ASCII bar graph for Claude Code usage limits.

Reads the same numbers as Claude Code's `/usage` screen (5-hour window,
all-models weekly line, Fable/Opus-scoped weekly line) straight from the
authenticated usage endpoint, using the OAuth credentials Claude Code already
keeps on disk. No daemon, one HTTP call, prints and exits.

    cu                just the three bars
    cu --credits      + a fourth bar for the extra-usage spend cap
    cu --json         raw endpoint response (no bars) — for scripting
    cu --no-color     plain text, no ANSI
    cu --width 30     wider bars (default 20)
    cu --watch        keep refreshing in place every 2 minutes, Ctrl+C to stop
    cu --watch --interval 60   same, every 60s instead

--watch redraws in the same terminal (clear + reprint) rather than scrolling,
and re-reads the credentials file from scratch every tick — so if Claude Code
refreshes the token in the background mid-watch (it does this on its own),
the next frame just picks it up. A single failed frame (network blip, an
expired token with nothing around to refresh it, a rate limit) prints its
error and keeps watching rather than killing the whole session.

Data source: GET https://api.anthropic.com/api/oauth/usage
Verified manually against a live token on 2026-08-29 — the `limits[]` array
in the response is the authoritative shape (self-describing kind/percent/
resets_at/scope), matched against what /usage renders. Top-level `five_hour`/
`seven_day` fields also exist and are used only as a fallback if `limits` is
ever missing.

Credentials: ~/.claude/.credentials.json, mode 0600, holds
claudeAiOauth.{accessToken, expiresAt (epoch ms), refreshToken, ...}.

LOAD-BEARING — no refresh, no writes, ever: the access token is short-lived
by design, but its refresh token rotates on use. If a live Claude Code
session is holding the current refresh token and this script silently
"helpfully" refreshed it too, Claude Code could get logged out. So: if the
access token has expired, this script fails cleanly and tells you to run
`claude` once (which refreshes it as a side effect) — it never calls the
token endpoint and never touches the credentials file.

Secrets rule: the access token is read into a local variable and used only
as an Authorization header value. It is never printed, logged, included in
an error message, or written anywhere. Only the JSON response body (which
contains no credentials) is ever surfaced, and only under --json.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

CREDENTIALS_PATH = Path.home() / ".claude" / ".credentials.json"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
DEFAULT_WIDTH = 20

# kind (from limits[]) -> display label, in the order Nick wants them shown
KIND_LABELS = {
    "session": "5-hour",
    "weekly_all": "weekly",
}

RESET = "\033[0m"
COLORS = {"green": "\033[32m", "yellow": "\033[33m", "red": "\033[31m"}


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def load_token():
    if not CREDENTIALS_PATH.exists():
        die(f"credentials not found at {CREDENTIALS_PATH} — is Claude Code logged in?", 2)
    try:
        data = json.loads(CREDENTIALS_PATH.read_text())
        oauth = data["claudeAiOauth"]
        token = oauth["accessToken"]
        expires_at_ms = oauth["expiresAt"]
    except (json.JSONDecodeError, KeyError) as e:
        die(f"could not read credentials ({type(e).__name__}) — unexpected file shape", 2)

    now_ms = time.time() * 1000
    if now_ms > expires_at_ms:
        age_min = (now_ms - expires_at_ms) / 60000
        die(
            f"Claude Code OAuth token expired {age_min:.0f}m ago — "
            "run `claude` once to refresh it, then retry",
            2,
        )
    return token


def fetch_usage(token):
    req = urllib.request.Request(
        USAGE_URL,
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-cli/2.0.0 (external, cli)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        hint = " (token likely expired — run `claude` once to refresh)" if e.code == 401 else ""
        die(f"usage API error {e.code}{hint}: {body}")
    except urllib.error.URLError as e:
        die(f"network error: {e.reason}")


def scoped_label(limit):
    """Label a weekly_scoped limit from its model display name, e.g. 'fable'."""
    scope = limit.get("scope") or {}
    model = scope.get("model") or {}
    name = model.get("display_name")
    return name.lower() if name else "weekly*"


def extract_rows(data):
    """Return a list of (label, percent, resets_at) from the usage payload."""
    limits = data.get("limits")
    if limits:
        rows = []
        for limit in limits:
            kind = limit.get("kind")
            label = KIND_LABELS.get(kind)
            if label is None and kind == "weekly_scoped":
                label = scoped_label(limit)
            if label is None:
                label = kind or "?"
            rows.append((label, limit.get("percent") or 0, limit.get("resets_at")))
        return rows

    # Fallback: legacy top-level fields, only used if limits[] is absent.
    rows = []
    five_hour = data.get("five_hour")
    if five_hour:
        rows.append(("5-hour", five_hour.get("utilization") or 0, five_hour.get("resets_at")))
    seven_day = data.get("seven_day")
    if seven_day:
        rows.append(("weekly", seven_day.get("utilization") or 0, seven_day.get("resets_at")))
    return rows


def fmt_reset(iso, now):
    if not iso:
        return "—"
    try:
        dt = datetime.fromisoformat(iso).astimezone()
    except ValueError:
        return "—"
    delta_days = (dt.date() - now.date()).days
    if delta_days == 0:
        return f"resets {dt.strftime('%H:%M')}"
    if 0 < delta_days <= 7:
        return f"resets {dt.strftime('%a %H:%M')}"
    return f"resets {dt.strftime('%b %-d %H:%M')}"


def color_for(pct):
    if pct >= 80:
        return "red"
    if pct >= 50:
        return "yellow"
    return "green"


def use_color(args):
    if args.no_color:
        return False
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def bar(pct, width):
    pct = max(0.0, min(100.0, pct))
    filled = round(pct / 100 * width)
    if pct > 0:
        filled = max(1, filled)
    filled = min(width, filled)
    return "█" * filled + "░" * (width - filled)


def render_row(label, pct, reset_str, width, colorize):
    b = bar(pct, width)
    pct_str = f"{pct:>3.0f}%"
    if colorize:
        c = COLORS[color_for(pct)]
        b = f"{c}{b}{RESET}"
        pct_str = f"{c}{pct_str}{RESET}"
    return f"  {label:<8} {b}  {pct_str}   {reset_str}"


def render_frame(args):
    """Fetch usage once and print one frame (bars or --json). May raise
    SystemExit via die() on a network/credentials failure — the caller
    decides whether that should end the program (one-shot) or just skip
    this frame (--watch)."""
    token = load_token()
    data = fetch_usage(token)

    if args.json:
        print(json.dumps(data, indent=2))
        return

    now = datetime.now().astimezone()
    colorize = use_color(args)

    header_time = now.strftime("%a %-d %b  %H:%M %Z")
    print(f"  CLAUDE USAGE                        {header_time}\n")

    for label, pct, resets_at in extract_rows(data):
        print(render_row(label, pct, fmt_reset(resets_at, now), args.width, colorize))

    if args.credits:
        spend = data.get("spend") or {}
        if spend.get("enabled"):
            pct = spend.get("percent") or 0
            used = spend.get("used", {})
            limit = spend.get("limit", {})
            exp = used.get("exponent", 2)
            used_amt = used.get("amount_minor", 0) / (10 ** exp)
            limit_amt = limit.get("amount_minor", 0) / (10 ** exp)
            money = f"${used_amt:.2f} / ${limit_amt:.2f}"
            print(render_row("credits", pct, money, args.width, colorize))


def clear_screen():
    if sys.stdout.isatty():
        print("\033[H\033[2J", end="")


def watch_loop(args):
    try:
        while True:
            clear_screen()
            try:
                render_frame(args)
            except SystemExit:
                pass  # die() already printed the reason to stderr; keep watching
            print(f"\n  (refreshing every {args.interval}s — Ctrl+C to stop)")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print()
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Show Claude Code usage limits as retro ASCII bars.",
    )
    parser.add_argument("--credits", action="store_true", help="also show the extra-usage spend bar")
    parser.add_argument("--no-color", action="store_true", help="disable ANSI color")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH, help=f"bar width (default {DEFAULT_WIDTH})")
    parser.add_argument("--json", action="store_true", help="print the raw endpoint response and exit")
    parser.add_argument("--watch", action="store_true", help="keep refreshing in place instead of exiting")
    parser.add_argument(
        "--interval", type=int, default=120,
        help="seconds between refreshes in --watch mode (default 120 = 2 min)",
    )
    args = parser.parse_args()

    if args.watch:
        if args.interval < 30:
            print(
                f"warning: --interval {args.interval}s is aggressive — the usage endpoint "
                "rate-limited at a few seconds apart during testing; 60+ is safer",
                file=sys.stderr,
            )
        return watch_loop(args)

    render_frame(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
