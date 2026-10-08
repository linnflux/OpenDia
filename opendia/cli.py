"""`opendia` command line."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sys
import threading
from importlib import resources
from pathlib import Path

from . import config as config_mod


def cmd_init(args) -> int:
    root = Path(args.dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    toml = root / "opendia.toml"
    if toml.exists() and not args.force:
        print(f"{toml} already exists (use --force to overwrite)")
        return 1
    toml.write_text(config_mod.DEFAULT_TOML)
    inbox = root / "inbox"
    inbox.mkdir(exist_ok=True)
    (root / "outbox").mkdir(exist_ok=True)
    if args.demo:
        for f in _fixtures():
            shutil.copy(f, inbox / Path(str(f)).name)
    print(f"Created {toml}" + (" with 3 demo emails in inbox/" if args.demo else ""))
    print("Next: opendia serve   (then open the approval inbox in your browser)")
    return 0


def _fixtures():
    try:
        pkg = resources.files("opendia") / "_fixtures"
        if pkg.is_dir():
            return sorted(p for p in pkg.iterdir() if p.name.endswith(".eml"))
    except (ModuleNotFoundError, FileNotFoundError):
        pass
    src = Path(__file__).resolve().parent.parent / "examples" / "fixtures"  # source checkout
    return sorted(src.glob("*.eml"))


def cmd_serve(args) -> int:
    from . import runtime
    cfg = config_mod.load(_cfg_path(args))
    runtime.start(cfg)
    stop = threading.Event()
    worker = threading.Thread(target=runtime.worker_loop, args=(stop,), daemon=True)
    worker.start()

    def shutdown(*_):
        stop.set()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    if args.no_web:
        print("OpenDia worker running (Ctrl-C to stop)", flush=True)
        stop.wait()
    else:
        import uvicorn

        from .web import create_app
        host, port = cfg.web.get("host", "127.0.0.1"), int(cfg.web.get("port", 8765))
        print(f"OpenDia running. Approval inbox: http://{host}:{port}", flush=True)
        server = uvicorn.Server(uvicorn.Config(create_app(), host=host, port=port,
                                               log_level="warning"))
        threading.Thread(target=lambda: (stop.wait(), setattr(server, "should_exit", True)),
                         daemon=True).start()
        server.run()
        stop.set()
    worker.join(timeout=10)
    runtime.stop()
    # Workflows waiting on an approval sit in a non-daemon DBOS thread blocked in recv().
    # Their state is already durable and resumes on the next start, so exit without waiting.
    sys.stdout.flush()
    os._exit(0)


def cmd_inbox(args) -> int:
    from .store import Store
    cfg = config_mod.load(_cfg_path(args))
    rows = Store(cfg.app_db_url).list(status=None if args.all else "pending")
    if args.json:
        print(json.dumps(rows, indent=2, default=str))
        return 0
    if not rows:
        print("Nothing waiting for approval.")
    for a in rows:
        e, d = a["context"]["email"], a["final"] or a["proposal"]
        print(f"[{a['status']}] {a['id']}\n  from:    {e['sender']}\n  subject: {e['subject']}\n"
              f"  reply to {d['to']}: {d['subject']}\n  " + d["body"].replace("\n", "\n  ") + "\n")
    return 0


def cmd_decide(args) -> int:
    from dbos import DBOSClient

    from .runtime import decision_message
    from .store import AlreadyDecided, Store
    cfg = config_mod.load(_cfg_path(args))
    store = Store(cfg.app_db_url)
    edited = None
    if args.action == "edit":
        row = store.get(args.id)
        if row is None:
            print(f"No approval {args.id}")
            return 1
        edited = dict(row["proposal"])
        for k in ("to", "subject", "body"):
            if getattr(args, k):
                edited[k] = getattr(args, k)
        if args.body_file:
            edited["body"] = Path(args.body_file).read_text()
    try:
        row = store.decide(args.id, args.action, args.by or cfg.operator, edited)
    except (AlreadyDecided, KeyError, ValueError) as e:
        print(f"Not recorded: {e}")
        return 1
    # Deliver now; if this fails, the running worker delivers it on its next tick.
    client = DBOSClient(system_database_url=cfg.system_db_url)
    try:
        client.send(row["workflow_id"], decision_message(row), "decision",
                    idempotency_key=f"decision:{row['id']}")
        store.mark_delivered(row["id"])
    finally:
        client.destroy()
    print(f"{row['status'].capitalize()}: {row['id']}")
    return 0


def cmd_runs(args) -> int:
    from dbos import DBOSClient
    cfg = config_mod.load(_cfg_path(args))
    client = DBOSClient(system_database_url=cfg.system_db_url)
    try:
        for w in client.list_workflows(sort_desc=True, limit=args.limit, load_input=False):
            out = (w.output or {}).get("outcome", "") if isinstance(w.output, dict) else ""
            print(f"{w.status:<10} {out:<16} {w.workflow_id}")
    finally:
        client.destroy()
    return 0


def cmd_audit(args) -> int:
    from .audit import report
    print(report(config_mod.load(_cfg_path(args)), args.run_id))
    return 0


def _cfg_path(args):
    return Path(args.config).resolve() if args.config else None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="opendia", description="Deterministic business workflows "
                                "with a human approval inbox.")
    p.add_argument("-c", "--config", help="path to opendia.toml (default: search upward)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="create opendia.toml here")
    s.add_argument("dir", nargs="?", default=".")
    s.add_argument("--demo", action="store_true", help="add sample emails to the inbox")
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_init)

    s = sub.add_parser("serve", help="run the worker and the approval inbox")
    s.add_argument("--no-web", action="store_true")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("inbox", help="list approvals")
    s.add_argument("--all", action="store_true")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_inbox)

    for action in ("approve", "reject", "edit"):
        s = sub.add_parser(action, help=f"{action} a pending approval")
        s.add_argument("id")
        s.add_argument("--by")
        if action == "edit":
            s.add_argument("--to")
            s.add_argument("--subject")
            s.add_argument("--body")
            s.add_argument("--body-file")
        s.set_defaults(fn=cmd_decide, action=action)

    s = sub.add_parser("runs", help="list recent workflow runs")
    s.add_argument("--limit", type=int, default=20)
    s.set_defaults(fn=cmd_runs)

    s = sub.add_parser("audit", help="plain-language report for one run")
    s.add_argument("run_id")
    s.set_defaults(fn=cmd_audit)

    args = p.parse_args(argv)
    if args.cmd == "edit":
        args.action = "edit"
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
