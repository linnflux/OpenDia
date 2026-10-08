# Contributing

Thanks for helping. A few rules keep OpenDia deterministic and safe.

## The determinism rule

Anything that can differ between runs belongs inside a `@DBOS.step`: model calls, network and
mail I/O, reading the clock, randomness, reading files that can change. Workflow bodies only
orchestrate. If you change the order or number of steps in a shipped workflow, bump
`WORKFLOW_VERSION` in `opendia/runtime.py` and say so in the pull request, because runs started
under the old version will not be recovered by the new code.

## Side effects

Every action that leaves the machine (sending mail, posting an invoice, calling a webhook) goes
through the effect ledger in `opendia/store.py` with an idempotency key, and its connector must
be able to answer "did this already happen?" (see `MailSink.already_sent`). A new side effect
needs a crash test in `tests/test_durability.py` that uses a failpoint to kill the worker
mid-effect.

## Models and credentials

Providers authenticate with API keys or cloud credentials only. Pull requests that read, store,
or forward consumer chat subscription logins or session tokens will not be accepted.

## Workflow

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
```

Keep pull requests small and include tests. Sample data must be synthetic (example.com,
example.org, example.net).

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
