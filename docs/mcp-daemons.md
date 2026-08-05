# Shared MCP Daemons — Operations

Local MCP servers run as **one shared HTTP daemon each**, not as a stdio
subprocess per Claude Code session. This collapses N sessions × M servers
down to M processes, and makes the tools survive a crash instead of
vanishing for the rest of the session.

## Why

Claude Code spawns its own stdio copy of every MCP server, per session. On a
box running many long-lived sessions that compounds badly — measured here at
**99 processes / 4.3 GB** immediately before cutover, against **4 processes /
329 MB** after.

The memory alone would be reason enough, but the failure mode was worse.
Under memory pressure `earlyoom` fires, and a `--prefer` regex matching
`node` will happily SIGTERM MCP servers by name. **Claude Code does not
restart a dead stdio subprocess** — the tools stay gone until the session is
restarted. The servers were never the problem; they were the collateral.

A systemd daemon with `Restart=always` inverts that: the tools heal
themselves, and a restart is invisible to every client.

## Moving parts

| Server | Port | Unit | MemoryMax |
|---|---|---|---|
| toggl | 7801 | `mcp-toggl.service` | 256M |
| notion | 7802 | `mcp-notion.service` | 256M |
| square | 7803 | `mcp-square.service` | 256M |
| google-workspace | 7804 | `mcp-google-workspace.service` | 512M |

Units live in [`systemd/`](../systemd/) and install to
`~/.config/systemd/user/`. Server source is expected at
`~/.claude/mcp-servers/<name>/` — outside this repo, since the servers are
per-deployment.

Secrets move out of `~/.claude.json` into `~/.mcp/<name>.env` (mode 0600),
read via `EnvironmentFile=`. google-workspace has no env secret; it reads
credentials and OAuth tokens from `MCP_CREDENTIALS_PATH`.

## The transport patch

Per server, in `src/index.ts`:

1. Wrap the existing `new Server(...)` plus both `setRequestHandler` blocks
   **verbatim** into a `createServer(): Server` factory.
2. Leave the env check, the API client, and the tool table at **module
   scope**. That sharing is the entire memory win — a per-request factory
   that also rebuilt the client would save nothing.
3. Replace `main()` with an `MCP_TRANSPORT` switch. **stdio stays the
   default**; the unit opts in with `Environment=MCP_TRANSPORT=http`.
4. Keep `console.error` (never `.log`) — the stdio path must stay clean.

Step 3 is what makes this safe to adopt: the patch is a strict superset of
the old behavior, so rolling the config back to stdio needs no rebuild.

## Why stateless (`sessionIdGenerator: undefined`)

- **Restart-transparent** — no session IDs to invalidate. A stateful server
  would 404 every client on restart, which defeats the whole point.
- **Leak-proof** — stateful retains a `Server` per session until the client
  sends DELETE. Sessions killed by OOM or `tmux kill-session` never do.
- The SDK forbids reusing a stateless transport, hence the per-request
  factory.
- **`GET /mcp` must return 405.** Otherwise stateless opens a standalone SSE
  stream that can never receive anything, pinning a `Server` alive per
  client and reintroducing the leak through the back door.

> **Stateless is valid ONLY because these servers never push to the client.**
> They register exactly ListTools and CallTool — no `server.notification()`,
> no sampling, no roots. If anyone adds a server-initiated notification or a
> progress-reporting long-running tool, stateless breaks and you need
> stateful sessions plus an idle reaper.

## OAuth in a daemon (google-workspace)

An interactive OAuth prompt reads `process.stdin`. A daemon has no stdin, so
first-time consent would block forever and every tool call would hang.

The guard sits at the **top of `promptForCode()`**, not in `initialize()`, so
every call path is covered:

```ts
if (!process.stdin.isTTY) {
  throw new Error("...re-authorize in a terminal, then restart the daemon");
}
```

**Throw, don't `process.exit(1)`.** The unit is `Restart=always` — exiting
hot-loops the daemon and buries the cause. Throwing surfaces the message
through the MCP error path and leaves the daemon up to serve the next
request, which succeeds the moment tokens are valid again.

Re-auth uses the standalone interactive entrypoint, in a real terminal:

```bash
node ~/.claude/mcp-servers/google-workspace/dist/auth.js
systemctl --user restart mcp-google-workspace
```

Both halves of the guard need testing if it's ever touched. A guard that
also fires in a TTY would lock you out of re-authorizing — silently, and
only when you next need it.

## Cutover

Always use the CLI, never hand-edit `~/.claude.json`. Live sessions rewrite
that file (startup counts, tool usage); a manual edit is a lost-update race.

```bash
claude mcp remove <name> -s user
claude mcp add --transport http <name> http://127.0.0.1:<port>/mcp -s user
claude mcp get <name>          # verify: type http, no env block
```

MCP config is **not** reloaded live. Already-running sessions keep their
stdio children until they exit, so memory falls as sessions turn over rather
than at cutover.

**Do not kill those children to hurry it along.** Claude Code won't restart
them, so you'd leave live sessions with permanently dead tools — the exact
failure this work removes. Reap *sessions* instead (see
[`session-reaper.md`](session-reaper.md)); the children exit with the parent.

## Verification

```bash
for s in toggl:7801 notion:7802 square:7803 google-workspace:7804; do
  n=${s%%:*}; p=${s##*:}
  printf '%-18s active=%-8s health=%s origin=%s get=%s\n' "$n" \
    "$(systemctl --user is-active mcp-$n)" \
    "$(curl -sS --max-time 3 http://127.0.0.1:$p/health >/dev/null && echo ok || echo FAIL)" \
    "$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$p/mcp -H 'Origin: http://evil.com' -d '{}')" \
    "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$p/mcp)"
done
# want: active, ok, origin=403, get=405
```

A `tools/list` POST needs **both** Accept types or it is rejected:

```bash
curl -sS -X POST http://127.0.0.1:<port>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Security (all must hold): bad `Origin` → 403, `GET /mcp` → 405, unknown path
→ 404, and `ss -ltn` shows `127.0.0.1` only — never `0.0.0.0`.

Resilience: `systemctl --user restart mcp-<name>`, then call a tool from an
already-open session. It must still work.

To prove a session is actually *using* a daemon rather than a leftover stdio
child, watch the counter move across a real tool call:

```bash
systemctl --user show mcp-notion -p CPUUsageNSec --value
```

## Gotchas

- **Never rename these processes** (no `exec -a mcpd-toggl`). earlyoom
  matches on process *name*; protection comes from `node` being in its
  `--avoid` regex. Renaming silently drops them out of it.
- **earlyoom's live config may not be the file you edited.** A
  `systemd` drop-in that hardcodes `ExecStart` overrides
  `/etc/default/earlyoom` entirely. Check what is actually running:
  `ps -eo args | grep '[e]arlyoom'`.
- `StartLimitIntervalSec` / `StartLimitBurst` belong in **`[Unit]`**, not
  `[Service]`, where modern systemd ignores them.
- `OOMScoreAdjust` must be **`0`, not negative** — a *user* unit has no
  `CAP_SYS_RESOURCE` and would fail to start outright.
- If a server's build OOMs against a large dependency's type graph (
  `googleapis` is the usual offender), transpile per-file instead of running
  a whole-program `tsc`. Don't "fix" it by running the type-check that was
  deliberately skipped.

## Rollback

| Failure | Rollback |
|---|---|
| Build breaks | `rm -rf dist && mv dist.bak-<ts> dist` |
| Daemon won't start | `systemctl --user disable --now mcp-<name>` — config untouched, nothing else affected |
| Tools fail in a new session | `claude mcp remove <name> -s user`, re-add as stdio. The binary still defaults to stdio, so no rebuild |
| `~/.claude.json` clobbered | stop the units, restore the backup (it still contains the secrets) |
| OAuth breaks | restore `tokens.json.bak-*`, or re-auth via `dist/auth.js` in a TTY and restart the unit |

Keep the `dist.bak-*` and `.claude.json.bak-*` copies until the daemons have
been stable for a week, then delete them — the config backups hold plaintext
secrets.
