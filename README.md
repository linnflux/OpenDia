# OpenDia

<img src="opendia_mark.svg" alt="OpenDia mark" width="120">

OpenDia is a business orchestration framework that connects your existing tools into a unified, AI-driven workflow. Your email, calendars, task management, billing, and time tracking all working together. It doesn't replace your systems. It makes them work together.

OpenDia is designed to be run by an **Operator**: a trained professional inside your organization who understands your processes, your clients, and your goals. The Operator directs OpenDia, not the other way around. This information was published in its initial state on March 12, 2026.

## What OpenDia says about itself

- **Not a SaaS product you hand logins to.** OpenDia runs on your infrastructure, with your data, under your control. No third-party dashboards where your business lives on someone else's server.
- **No rip-and-replace.** You keep your existing email, project management, time tracking, and invoicing tools. OpenDia is the layer that ties them together.
- **Human-in-the-loop by design.** AI handles the tedious coordination. The Operator makes the decisions. This isn't "set it and forget it" automation. It's augmented operations.
- **Built for service businesses.** Agencies, consultancies, MSPs, and anyone juggling multiple clients, tools, and workflows.

## The open source engine

**Deterministic, self-hosted workflows for business operations. AI does the drafting; the Operator approves; every side effect happens exactly once.**

Hosted agent products like Meta Muse and OpenAI Dots take a goal and decide on their own what to do next. That is useful, and it is also the problem: you cannot replay what happened, you cannot prove it will not happen twice, and your data lives on someone else's computer.

OpenDia takes the other side. You decide the steps. The model fills in the parts that need judgment (classify this email, draft that reply) inside steps that are recorded. A person approves anything that leaves the building. If the machine dies halfway through, OpenDia resumes exactly where it stopped, without calling the model again and without sending anything twice.

> Muse and Dots decide what to do. OpenDia runs what you decided, on your box, with a receipt.

Status: **v0.1 alpha.** One workflow ships (email triage). The engine underneath is general.

## Quickstart (no API keys needed)

```bash
pip install opendia            # Python 3.11+
mkdir ops && cd ops
opendia init --demo            # config + three sample emails
opendia serve                  # worker + approval inbox at http://127.0.0.1:8765
```

Open the inbox. The newsletter was filed without a reply. The two emails that need an answer are waiting with drafted replies. Edit one, approve it, and it lands in `outbox/` exactly once. Then:

```bash
opendia runs                                   # every run and its outcome
opendia audit 'email:<demo-001@example.org>'   # plain-language report for one run
```

The demo uses a built-in fake model so it runs offline. To use a real one, edit `opendia.toml`.

## What it guarantees

Each guarantee has a test that kills the worker at the worst possible moment (`tests/test_durability.py`):

| Guarantee | How |
|---|---|
| The same email never starts two runs | Run id = the email's Message-ID |
| A recovered run never calls the model again | Step outputs are checkpointed; replays read them back |
| An approved reply is sent once, even if the process dies mid-send | Side-effect ledger plus a deterministic Message-ID checked before any retry |
| Approvals survive restarts, and you can decide while the worker is down | Decisions are durable messages, delivered on the next start |
| A decision is recorded once; late or duplicate clicks fail | Conditional state transitions (`pending` to one final state) |
| Unanswered approvals expire on a durable deadline | The deadline is stored, not held in memory |

The engine is [DBOS Transact](https://github.com/dbos-inc/dbos-transact-py) (MIT): durable execution in a library, on SQLite or Postgres, with no cluster to run.

## Models

OpenDia is model-agnostic. Pick one in `opendia.toml`:

```toml
[provider]
kind = "anthropic"                      # pip install 'opendia[anthropic]'
model = "claude-haiku-4-5-20251001"     # uses ANTHROPIC_API_KEY; platform = "bedrock" | "vertex" also work

# kind = "openai", model = "gpt-4o-mini"                                        # OPENAI_API_KEY
# kind = "openai", model = "llama3.1", base_url = "http://localhost:11434/v1"   # Ollama, fully local
# kind = "mypackage.module:MyProvider"                                          # your own
```

OpenDia authenticates with API keys or cloud credentials only. It does not use, store, or forward consumer chat subscriptions or their login tokens; model providers' terms generally do not allow third-party apps to do that.

Email content is always passed to the model as data inside delimiters, with instructions to ignore anything in it that looks like a command. That lowers the risk of prompt injection but does not remove it, which is why nothing is sent without a person approving it. Approval cannot be turned off in v0.1.

## Real mail

```toml
[mail]
source = "imap"
sink = "smtp"
from_address = "you@yourcompany.com"
# disclosure_footer = "Drafted with AI assistance and reviewed by a person before sending."

[mail.imap]
host = "imap.gmail.com"
username = "you@yourcompany.com"
password_env = "OPENDIA_IMAP_PASSWORD"   # an app password, never your main password
sent_folder = "[Gmail]/Sent Mail"

[mail.smtp]
host = "smtp.gmail.com"
username = "you@yourcompany.com"
password_env = "OPENDIA_SMTP_PASSWORD"
append_to_sent = false                   # Gmail saves to Sent itself; most other servers need true
```

IMAP is read with `BODY.PEEK`, so OpenDia never marks your mail as read. Before any send or retry, it searches the Sent folder for the reply's Message-ID. One gap remains: a crash after the SMTP server accepts a message but before the message appears in Sent. Providers that file to Sent on submit make that window very small.

## How it works

```
email ──> classify (LLM step) ──> draft (LLM step) ──> approval inbox ──> send (ledger step)
             recorded                 recorded           durable wait         exactly once
```

A workflow is plain Python. The rule that makes it deterministic: anything that can differ between runs (model calls, network, clock, randomness) goes inside a `@DBOS.step`. The workflow body only orchestrates. See `opendia/workflows.py`.

```
opendia/
  workflows.py     the email triage workflow
  providers/       fake, anthropic, openai-compatible
  connectors/      maildir + file (demo), IMAP + SMTP
  store.py         approval inbox and side-effect ledger tables
  web/             the one-page approval inbox
  audit.py         plain-language run reports
```

## Security notes for v0.1

- The web inbox has no login. It binds to `127.0.0.1` by default; keep it there or put it behind your own auth (SSH tunnel, Tailscale, a reverse proxy with SSO).
- SQLite is fine for one operator on one box. DBOS recommends Postgres for production: set `database_url` and install `opendia[postgres]`.
- Secrets come from environment variables named in the config, never from the config file itself.

## Roadmap

- Workflow definitions beyond email (time entries to invoice drafts, ticket triage)
- Approval routing: assignees, escalation, approvals by email or chat
- Per-client workspaces and cost ledgers for agencies and MSPs
- Auth for the web inbox

## Development

```bash
git clone https://github.com/linnflux/OpenDia && cd OpenDia
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## History

- **March 12, 2026:** OpenDia first published, as documentation of the Operator model Linnflux runs its own business on.
- **March 14, 2026:** this repository's first commits. They are kept at the root of the history as the launch record, and were released under the MIT license.
- **October 2026:** relaunched as an open source, single-operator engine (v0.1), under Apache-2.0 from that commit forward.

## License

Apache-2.0. Copyright 2026 Linnflux, Inc. OpenDia is an independent project and is not affiliated with or endorsed by Anthropic, OpenAI, Meta, or DBOS.
