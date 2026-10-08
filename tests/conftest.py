"""Durability tests run the real CLI in subprocesses and kill it at chosen points."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent.parent / "examples" / "fixtures"


class Harness:
    def __init__(self, root: Path, expires_seconds: float | None):
        self.root = root
        (root / "inbox").mkdir()
        (root / "outbox").mkdir()
        approvals = (f"expires_seconds = {expires_seconds}" if expires_seconds
                     else "expires_hours = 72")
        (root / "opendia.toml").write_text(f"""
[opendia]
state_dir = ".opendia"
operator = "tester"
[provider]
kind = "fake"
[mail]
source = "maildir"
sink = "file"
from_address = "ops@example.com"
poll_seconds = 0.5
[approvals]
{approvals}
""")
        self.calls = root / "model_calls.log"

    def add_email(self, name: str) -> None:
        shutil.copy(FIXTURES / name, self.root / "inbox" / name)

    def env(self, failpoint: str | None = None) -> dict:
        e = {**os.environ, "OPENDIA_FAKE_CALL_LOG": str(self.calls)}
        e.pop("OPENDIA_FAILPOINT", None)
        if failpoint:
            e["OPENDIA_FAILPOINT"] = failpoint
        return e

    def cli(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "opendia", *args], cwd=self.root,
                              env=self.env(), capture_output=True, text=True, timeout=60,
                              check=check)

    def serve_until(self, cond, *, failpoint: str | None = None, timeout: float = 30) -> int:
        """Run the worker until cond() holds, or until it crashes itself at the failpoint.
        Returns the exit code (137 = crashed at the failpoint)."""
        p = subprocess.Popen([sys.executable, "-m", "opendia", "serve", "--no-web"], cwd=self.root,
                             env=self.env(failpoint), stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + timeout
        try:
            while time.time() < deadline:
                if p.poll() is not None:
                    return p.returncode
                if cond():
                    p.send_signal(signal.SIGTERM)
                    return p.wait(timeout=20)
                time.sleep(0.3)
            raise AssertionError("condition not reached in time; worker output:\n"
                                 + (p.stdout.read() if p.poll() is not None else "(still running)"))
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()

    def kill9_when(self, cond, timeout: float = 30) -> None:
        p = subprocess.Popen([sys.executable, "-m", "opendia", "serve", "--no-web"], cwd=self.root,
                             env=self.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout
        while time.time() < deadline and not cond():
            time.sleep(0.3)
        p.kill()
        p.wait()
        assert cond(), "condition not reached before kill"

    # state readers (fresh connections each call; the worker is another process) ------------

    def store(self):
        from opendia.config import load
        from opendia.store import Store
        return Store(load(self.root / "opendia.toml").app_db_url)

    def approvals(self, status: str | None = None) -> list[dict]:
        return self.store().list(status=status)

    def outbox(self) -> list[Path]:
        return sorted((self.root / "outbox").glob("*.eml"))

    def model_calls(self) -> int:
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0

    def run_outcome(self, wid: str):
        from dbos import DBOSClient
        from sqlalchemy.exc import OperationalError

        from opendia.config import load
        cfg = load(self.root / "opendia.toml")
        if not (cfg.state_dir / "system.sqlite").exists():
            return None
        c = DBOSClient(system_database_url=cfg.system_db_url)
        try:
            w = c.list_workflows(workflow_ids=[wid])
        except OperationalError:  # worker hasn't created the schema yet
            return None
        finally:
            c.destroy()
        return w[0].output["outcome"] if w and w[0].status == "SUCCESS" else None


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path, expires_seconds=None)


@pytest.fixture
def fast_expiry(tmp_path):
    return Harness(tmp_path, expires_seconds=2)
