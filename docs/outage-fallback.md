# Anthropic Outage Fallback — Operations

When Anthropic is unreachable, OpenDia fails over to **the same Claude models on AWS
Bedrock**. Separate infrastructure, separate SLA, identical models — so there is no
tool-calling degradation, and MCP servers, skills, and slash commands all keep working
(they are client-side features of the Claude Code CLI, not the model API).

Prompted by the 2026-07-29 outage: ~3 hours (19:49–22:36 UTC), `529 Overloaded`, which
took down claude.ai, the API, and Claude Code together.

## During an outage — what to do

```bash
od-fallback check     # confirm Bedrock is reachable (should already be PASS)
od-fallback on        # switch this shell to Bedrock
claude --resume <session>
```

Then work normally. When Anthropic recovers:

```bash
od-fallback off       # back to the subscription
```

`od-fallback` is an alias for `source ~/OpenDia/repo/scripts/od-fallback.sh` — it must
be **sourced**, because it mutates the current shell's environment. It only affects
sessions started from that shell.

**Cost note:** normal operation uses the Max subscription (free at the margin). Bedrock
is pay-per-token, so turn it off once the outage clears.

## What breaks, and what doesn't

**Unaffected — no Claude dependency at all:** calendar sync, nightly Drive backup,
deadline watch, Lonely Whistle, log rotation, session reaper, build-registry sync, and
the dashboard UI itself. Most of OpenDia keeps running.

**Affected:**

| Surface | Behavior during an outage |
|---|---|
| Inbox classification (5-min cron) | **Auto-fails over to Bedrock** (see below). Without it, threads get relabeled `OpenDia Error` and need manual reprocessing. |
| Interactive Claude Code | Manual `od-fallback on` + resume. |
| Dashboard Review button | Degrades gracefully today — omits the AI block, rest of the review still renders. |
| Dashboard Sweep | Serves its last cached result, flagged `stale` after 24h. |
| Dashboard Newsletter | Errors; retry after recovery, or generate from a fallback session. |

To put the dashboard's own `claude -p` calls on Bedrock too, add the same variables to
its systemd `EnvironmentFile` and `systemctl --user restart opendia-dashboard`.

## Automatic fallback: inbox classification

`repo/scripts/classify_email.py` calls Anthropic with an API key (from
`~/.config/opendia/inbox.env` — a separate, ToS-clean credential from the interactive
OAuth session). `_create_message()` catches `APIStatusError` / `APIConnectionError` /
`APITimeoutError` and retries once against `anthropic.AnthropicBedrock`.

**Requires `boto3` + `botocore`** (installed to user site-packages with
`pip3 install --user --break-system-packages`, since this system's Python is
externally managed under PEP 668). Note the trap: `AnthropicBedrock` *instantiates*
fine without them, so an import check passes — but the signed request fails at call
time with `No module named 'boto3'`. Only a real end-to-end invoke proves the path.

Bedrock is used **only on failure** — no steady-state cost. If Bedrock is unconfigured
or also failing, the **original** Anthropic error is re-raised, so behavior is identical
to before this change.

## Configuration

`~/OpenDia/.od-fallback.conf` (machine-specific, not in git) is read by both the shell
script and `classify_email.py`:

```
OD_FALLBACK_REGION=us-east-1
OD_FALLBACK_MODEL=us.anthropic.<main-model-id>
OD_FALLBACK_SMALL_MODEL=us.anthropic.<haiku-model-id>
```

Get the real IDs with:

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId" \
  --output text
```

**Use the `us.` inference-profile IDs, not the bare model IDs** — bare IDs fail with
"Invocation … with on-demand throughput isn't supported".

Verified working on this account (2026-07-30): `us.anthropic.claude-opus-5` (current
main), `us.anthropic.claude-opus-4-8`, `us.anthropic.claude-sonnet-4-6`,
`us.anthropic.claude-haiku-4-5-20251001-v1:0` (current small).

**Known exception:** `us.anthropic.claude-fable-5` is enabled in the Bedrock catalog
but fails to invoke — `ValidationException: data retention mode 'default' is not
available for this model`. So the fallback main model is Opus 5 rather than Fable 5,
even though Fable 5 is the normal interactive default. Worth re-testing later.

## One-time AWS setup

1. **IAM** — attach to user `opendia`: `bedrock:ListFoundationModels`,
   `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`
   (`AmazonBedrockFullAccess` is the quick path).
2. **Model access** — Bedrock console → Model access → enable the Anthropic Claude
   models in `us-east-1`.
3. **Write the conf** with the real model IDs, then `od-fallback check` → PASS.

## Keep it honest — test it cold

A fallback that has never been exercised is not a fallback. Run `od-fallback check`
periodically (monthly is plenty) and after any AWS credential change. The failure this
whole thing exists to prevent is discovering, mid-outage, that Bedrock was never
actually enabled.

Full dress rehearsal, worth doing once: `od-fallback on`, resume a session, and confirm
an MCP tool, a slash command, and a multi-step tool chain (read → edit → run) all work.

**Rehearsal completed 2026-07-30 — PASS.** Resumed the `od-dash` session on Bedrock
(Opus 5) and verified: MCP servers work (Google Workspace `chat_list_spaces`, Notion
`notion_get_me`), a read → edit → run tool chain works, and the local reads that slash
commands depend on (timer state files, dashboard `/api/projects`) work. Nothing about the
session behaved differently apart from the model being Opus 5 instead of Fable 5.

## Deliberately not used

- **No LiteLLM proxy.** Nothing for it to do here: interactive uses Claude Code's native
  Bedrock support, and the one direct-SDK caller falls back in-process. A proxy daemon
  would add a port, a config, and a second credential store for no benefit. (LiteLLM
  1.82.7/1.82.8 shipped credential-stealing malware — the installed 1.94.0 is clean, but
  it is a reason to keep the dependency surface small.)
- **Never proxy the subscription OAuth token.** Anthropic's consumer ToS prohibits using
  Free/Pro/Max OAuth tokens in any other product, tool, or service, and enforcement has
  suspended accounts. That would trade a 3-hour outage for a permanent one.
- **Gemini is not used for interactive work.** Claude Code driving Gemini has documented
  tool-calling degradation on exactly the multi-step agentic work OpenDia does. The
  Gemini key remains available as a possible last-resort third link.
