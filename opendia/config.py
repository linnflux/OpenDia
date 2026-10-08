"""Load `opendia.toml`. Every identifier lives here, never in code."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TOML = """\
# OpenDia configuration. Paths are relative to this file.

[opendia]
state_dir = ".opendia"          # SQLite databases live here
# database_url = "postgresql://user:pass@localhost/opendia"   # optional; replaces SQLite
operator = "operator"           # recorded as the approver for web/CLI decisions

[provider]
kind = "fake"                   # fake | anthropic | openai | "package.module:Class"
model = ""
# Anthropic:  kind = "anthropic", model = "claude-haiku-4-5-20251001", api_key_env = "ANTHROPIC_API_KEY"
#             platform = "bedrock" | "vertex" uses those clouds' credentials instead of an API key.
# OpenAI:     kind = "openai", model = "gpt-4o-mini", api_key_env = "OPENAI_API_KEY"
# Ollama:     kind = "openai", model = "llama3.1", base_url = "http://localhost:11434/v1"

[mail]
source = "maildir"              # maildir | imap
sink = "file"                   # file | smtp
inbox_dir = "inbox"             # maildir source: drop .eml files here
outbox_dir = "outbox"           # file sink: approved replies are written here
from_address = "you@example.com"
poll_seconds = 5
# disclosure_footer = "Drafted with AI assistance and reviewed by a person before sending."

# [mail.imap]   host = "imap.example.com"  port = 993  username = "you@example.com"  password_env = "OPENDIA_IMAP_PASSWORD"  folder = "INBOX"  sent_folder = "Sent"
# [mail.smtp]   host = "smtp.example.com"  port = 587  username = "you@example.com"  password_env = "OPENDIA_SMTP_PASSWORD"  append_to_sent = true

[approvals]
expires_hours = 72

[web]
host = "127.0.0.1"              # the inbox has no login in v0.1: keep it on localhost
port = 8765
"""


@dataclass
class Config:
    path: Path
    root: Path
    state_dir: Path
    database_url: str | None
    operator: str
    provider: dict = field(default_factory=dict)
    mail: dict = field(default_factory=dict)
    approvals: dict = field(default_factory=dict)
    web: dict = field(default_factory=dict)

    @property
    def system_db_url(self) -> str:
        return self.database_url or f"sqlite:///{self.state_dir / 'system.sqlite'}"

    @property
    def app_db_url(self) -> str:
        return self.database_url or f"sqlite:///{self.state_dir / 'app.sqlite'}"

    @property
    def approval_timeout_seconds(self) -> float:
        a = self.approvals
        if "expires_seconds" in a:  # used by tests; hours is the documented knob
            return float(a["expires_seconds"])
        return float(a.get("expires_hours", 72)) * 3600

    def resolve(self, p: str) -> Path:
        path = Path(p).expanduser()
        return path if path.is_absolute() else self.root / path


def find_config(start: Path | None = None) -> Path:
    here = (start or Path.cwd()).resolve()
    for d in (here, *here.parents):
        if (d / "opendia.toml").is_file():
            return d / "opendia.toml"
    raise FileNotFoundError("No opendia.toml found here or in any parent. Run `opendia init` first.")


def load(path: Path | None = None) -> Config:
    path = (path or find_config()).resolve()
    data = tomllib.loads(path.read_text())
    core = data.get("opendia", {})
    root = path.parent
    cfg = Config(
        path=path,
        root=root,
        state_dir=root / core.get("state_dir", ".opendia"),
        database_url=core.get("database_url"),
        operator=core.get("operator", "operator"),
        provider=data.get("provider", {"kind": "fake"}),
        mail=data.get("mail", {}),
        approvals=data.get("approvals", {}),
        web=data.get("web", {}),
    )
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    return cfg
