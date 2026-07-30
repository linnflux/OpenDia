#!/usr/bin/env python3
"""
intake_pipeline.py — FluxCC Intake Automation Pipeline

Polls Tally forms 68QDQA (triage/lead) and QKBRQl (deep intake) and
orchestrates 8-stage lead processing: inbox row, design research,
Nick notification draft, git scaffold, CF Pages deploy, hero image,
final notification.

Usage:
  python3 intake_pipeline.py poll                         # cron-callable
  python3 intake_pipeline.py triage-lead <submission_id>  # manual re-run
  python3 intake_pipeline.py scaffold-from-intake <id>    # manual re-run
  python3 intake_pipeline.py poll --fixture <file.json>   # test without Tally token

Tally REST API token: ~/.claude/mcp-credentials/tally/token (chmod 600)
  Create at: https://tally.so/help/api (Account > Developer > API Keys)
  Without a token, poll gracefully skips Tally fetches; use --fixture for testing.
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Constants ────────────────────────────────────────────────────────────────

FORM_68QDQA = "68QDQA"
FORM_QKBRQL = "QKBRQl"

FIELD_MAP_68QDQA = {
    "pAZK91": "name",
    "1KBl5g": "email",
    "MOGbyl": "phone",
    "JRB6Yr": "biz_name",
    "gAO0rP": "design_intent",
    "yy76k8": "site_type",
    "XGNDyP": "design_description",
    "8kEK5l": "admired_urls",
    "0MAx59": "has_branding",
    "zzbqvk": "uploaded_designs",
    "5kOz5N": "design_notes",
    "dAR6Vr": "content_intent",
    "YOqQyN": "biz_description",
    "D1WNyl": "pages_needed",
    "lA4yZo": "additional_notes",
    "R4r0aK": "content_uploads",
    "oBxy1b": "content_notes",
}

FIELD_MAP_QKBRQL = {
    "XG9JPz": "biz_name",
    "8k2a4r": "tagline",
    "0MGBRA": "email",
    "zzgy5g": "ada_email",
    "5krjPQ": "phone",
    "dAgaeV": "address",
    "YOe0lv": "city",
    "D1bk6E": "state",
    "lAgekX": "zip",
    "R42MyQ": "country",
    "oBgeLN": "hours",
    "G1k9AO": "service_area",
    "OPr4MM": "logo",
    "VlqQO6": "favicon",
    "PE41Jx": "primary_hex",
    "E1Ad72": "accent_hex",
    "rKgaMX": "accent_dark_hex",
    "4kEJV5": "og_image",
    "jMg6A1": "elevator_pitch",
    "2kVaGM": "hero_heading",
    "xQgM5k": "hero_subheading",
    "R42M9K": "about_paragraphs",
    "oBgejb": "services_block",
    "G1k9Pe": "services_content",
    "OPr4Na": "final_cta",
    "VlqQ6j": "nav_items",
    "PE41q1": "page_list",
    "E1AdOl": "social_links",
    "rKgaZo": "tally_contact_id",
    "4kEJbr": "tally_started_id",
    "jMg6VQ": "maps_url",
    "2kVa6e": "domain",
    "xQgMWd": "registrar",
    "ZVWEBV": "dns_on_cf",
    "NVElZ0": "privacy_email",
    "qBgDlO": "terms_state",
    "QrjeQY": "accessibility_email",
}

VARIANT_MAP = {
    "Business / Service": "fluxcc-business",
    "Legal / Professional": "fluxcc-legal",
    "Author / Creative": "fluxcc-author",
    "Church / Faith Community": "fluxcc-church",
    "Something else": "fluxcc",
}

CONFIRMED_AUTO_SEND = False

# Paths
TALLY_TOKEN_PATH = Path.home() / ".claude" / "mcp-credentials" / "tally" / "token"
NOTION_TOKEN_PATH = Path.home() / ".config" / "opendia" / "notion_token"
LSAILR_PATH = Path.home() / "Admin" / "Workflow" / "CLI" / "CLI" / "lsailr" / "lsailr.sh"
SEEN_STATE = Path.home() / "OpenDia" / ".intake-seen.json"
DB_PATH = Path.home() / "OpenDia" / "opendia.db"
SCRIPTS_DIR = Path.home() / "OpenDia" / "scripts"
REPOS_ROOT = Path.home() / "FluxCC"
DEBUG_DIR = Path.home() / "OpenDia" / "Debug"
LOG_DIR = Path.home() / "OpenDia" / "logs"
GLAB_PATH = Path.home() / ".local" / "bin" / "glab"
GITLAB_TOKEN_PATH = Path.home() / ".claude" / "mcp-credentials" / "gitlab" / "token"

# Notion
from opendia_config import get_id  # noqa: E402

BUILD_REGISTRY_TABLE_ID = get_id("NOTION_BUILD_REGISTRY_ID")
TASKS_DB_ID = get_id("NOTION_TASKS_DB_ID")
NOTION_API_BASE = "https://api.notion.com/v1"

# Cloudflare
CF_EMAIL = "nick@linnflux.com"

# Tally REST API
TALLY_API_BASE = "https://api.tally.so"


# ── Credential loading ────────────────────────────────────────────────────────

def load_tally_token():
    if not TALLY_TOKEN_PATH.exists():
        raise FileNotFoundError(
            f"Tally API token not found at {TALLY_TOKEN_PATH}.\n"
            "Create one at https://tally.so/help/api and save to that path (chmod 600)."
        )
    return TALLY_TOKEN_PATH.read_text().strip()


def load_notion_token():
    if not NOTION_TOKEN_PATH.exists():
        raise FileNotFoundError(f"Notion token not found at {NOTION_TOKEN_PATH}.")
    return NOTION_TOKEN_PATH.read_text().strip()


def load_cf_api_key():
    """Extract Cloudflare Global API key from lsailr.sh."""
    if not LSAILR_PATH.exists():
        raise FileNotFoundError(f"lsailr.sh not found at {LSAILR_PATH}")
    text = LSAILR_PATH.read_text()
    m = re.search(r"X-Auth-Key:\s*([a-f0-9A-F]{30,40})", text)
    if not m:
        raise ValueError(f"Could not extract CF API key from {LSAILR_PATH}")
    return m.group(1)


def load_gitlab_token():
    return GITLAB_TOKEN_PATH.read_text().strip()


# ── Tally REST API ─────────────────────────────────────────────────────────────

def fetch_submissions_api(form_id):
    """Fetch all completed submissions via Tally REST API. Requires token."""
    token = load_tally_token()
    submissions = []
    page = 1
    while True:
        url = f"{TALLY_API_BASE}/forms/{form_id}/submissions?page={page}&limit=50"
        req = urllib.request.Request(
            url, headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Tally API error {e.code} for {form_id}: {body[:400]}")
        subs = data.get("submissions", [])
        # Only process completed submissions
        submissions.extend(s for s in subs if s.get("isCompleted"))
        if not data.get("hasMore"):
            break
        page += 1
    return submissions


# ── Seen-state dedup ──────────────────────────────────────────────────────────

def load_seen():
    if SEEN_STATE.exists():
        try:
            return json.loads(SEEN_STATE.read_text())
        except Exception:
            return {}
    return {}


def save_seen(seen):
    SEEN_STATE.write_text(json.dumps(seen, indent=2))


def mark_seen(seen, form_id, submission_id):
    seen.setdefault(form_id, {})[submission_id] = datetime.now(timezone.utc).isoformat()
    save_seen(seen)


def is_seen(seen, form_id, submission_id):
    return submission_id in seen.get(form_id, {})


# ── Payload normalization ──────────────────────────────────────────────────────

def normalize(submission, field_map):
    """Build canonical_name → answer from Tally submission. Missing = None."""
    responses = {r["questionId"]: r.get("answer") for r in submission.get("responses", [])}
    return {name: responses.get(qid, None) for qid, name in field_map.items()}


def first_label(val):
    """MC answers are lists. Return first element or the value if already a string."""
    if isinstance(val, list) and val:
        return val[0]
    return val if isinstance(val, str) else None


def file_mimes(val):
    """File-upload answer → list of (url, mimeType) pairs."""
    if not val:
        return []
    if isinstance(val, list):
        return [
            (f.get("url", ""), f.get("mimeType", "application/octet-stream"))
            for f in val
            if isinstance(f, dict) and f.get("url")
        ]
    return []


# ── Slug generation ──────────────────────────────────────────────────────────

def slugify(name):
    s = (name or "unknown").lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s-]+", "-", s).strip("-")
    return s or "unknown"


def unique_slug(base_slug, exclude_gmail_id=None):
    """Return base_slug or base_slug-2, -3… to avoid collisions in inbox_items."""
    conn = _db_conn()
    try:
        query = "SELECT client_hint FROM inbox_items WHERE client_hint LIKE ?"
        params = [base_slug + "%"]
        if exclude_gmail_id:
            query += " AND gmail_id != ?"
            params.append(exclude_gmail_id)
        existing = {row[0] for row in conn.execute(query, params).fetchall()}
    finally:
        conn.close()
    if base_slug not in existing:
        return base_slug
    i = 2
    while f"{base_slug}-{i}" in existing:
        i += 1
    return f"{base_slug}-{i}"


# ── SQLite helpers ────────────────────────────────────────────────────────────

def _db_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # Ensure intake columns exist (non-destructive migrations)
    cols = {row[1] for row in conn.execute("PRAGMA table_info(inbox_items)")}
    for col, defn in [
        ("notes", "TEXT"),
        ("error_text", "TEXT"),
        ("client_hint", "TEXT"),
        ("division_hint", "TEXT"),
    ]:
        if col not in cols:
            conn.execute(f"ALTER TABLE inbox_items ADD COLUMN {col} {defn}")
    conn.commit()
    return conn


def upsert_inbox_row(gmail_id, from_addr, subject, status,
                     client_hint, division_hint="WordFlux",
                     notes=None, error_text=None):
    """Insert or update inbox_items row keyed by gmail_id. Returns row id."""
    conn = _db_conn()
    try:
        existing = conn.execute(
            "SELECT id FROM inbox_items WHERE gmail_id = ?", (gmail_id,)
        ).fetchone()
        if existing:
            parts, vals = ["status = ?", "updated_at = datetime('now')"], [status]
            if notes is not None:
                parts.append("notes = ?"); vals.append(notes)
            if error_text is not None:
                parts.append("error_text = ?"); vals.append(error_text)
            vals.append(gmail_id)
            conn.execute(f"UPDATE inbox_items SET {', '.join(parts)} WHERE gmail_id = ?", vals)
        else:
            conn.execute("""
                INSERT INTO inbox_items
                  (gmail_id, from_addr, subject, status, client_hint, division_hint,
                   notes, error_text, priority)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal')
            """, (gmail_id, from_addr, subject, status, client_hint, division_hint,
                  notes, error_text))
        conn.commit()
        row = conn.execute("SELECT id FROM inbox_items WHERE gmail_id = ?", (gmail_id,)).fetchone()
        return row["id"] if row else None
    finally:
        conn.close()


def get_inbox_row_by_gmail_id(gmail_id):
    conn = _db_conn()
    try:
        row = conn.execute(
            "SELECT * FROM inbox_items WHERE gmail_id = ?", (gmail_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def find_lead_by_email(email):
    """Match QKBRQl email to a prior 68QDQA lead inbox row."""
    conn = _db_conn()
    try:
        row = conn.execute(
            "SELECT * FROM inbox_items "
            "WHERE from_addr = ? AND gmail_id LIKE 'tally:68QDQA:%' "
            "ORDER BY created_at DESC LIMIT 1",
            (email,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ── Notion REST helpers ───────────────────────────────────────────────────────

def _notion_req(method, path, body=None):
    token = load_notion_token()
    url = f"{NOTION_API_BASE}/{path.lstrip('/')}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Notion {method} {path} → {e.code}: {detail[:400]}")


def _cell(text):
    return [{"type": "text", "text": {"content": str(text) if text else ""}}]


def append_registry_row(client, slug, status,
                         gitlab_repo="", cf_project="", preview_url=""):
    """Append new table_row to Build Registry. 8 cols: Client, ShortName, CF, Preview, Domain, GitLab, Status, Launched."""
    _notion_req("PATCH", f"blocks/{BUILD_REGISTRY_TABLE_ID}/children", {
        "children": [{
            "object": "block",
            "type": "table_row",
            "table_row": {
                "cells": [
                    _cell(client),
                    _cell(slug),
                    _cell(cf_project),
                    _cell(preview_url),
                    _cell(""),
                    _cell(gitlab_repo),
                    _cell(status),
                    _cell(""),
                ]
            }
        }]
    })


def find_registry_row_id(slug):
    """Return block_id of the Registry row whose Short Name (col 1) matches slug."""
    result = _notion_req("GET", f"blocks/{BUILD_REGISTRY_TABLE_ID}/children?page_size=100")
    for block in result.get("results", []):
        if block.get("type") != "table_row":
            continue
        cells = block["table_row"]["cells"]
        if len(cells) > 1:
            short_name = "".join(r.get("plain_text", "") for r in cells[1])
            if short_name == slug:
                return block["id"]
    return None


def update_registry_row(row_block_id, **kwargs):
    """Update named columns in a Registry row. Kwarg names: client, slug, cf_project,
    preview_url, custom_domain, gitlab_repo, status, launched."""
    col_idx = {
        "client": 0, "slug": 1, "cf_project": 2, "preview_url": 3,
        "custom_domain": 4, "gitlab_repo": 5, "status": 6, "launched": 7,
    }
    current = _notion_req("GET", f"blocks/{row_block_id}")
    cells = current["table_row"]["cells"]
    for name, val in kwargs.items():
        idx = col_idx.get(name)
        if idx is not None and idx < len(cells):
            cells[idx] = _cell(val)
    _notion_req("PATCH", f"blocks/{row_block_id}", {"table_row": {"cells": cells}})


def create_notion_task(title, body_text):
    """Create an Open WordFlux task in the Tasks database."""
    return _notion_req("POST", "pages", {
        "parent": {"database_id": TASKS_DB_ID},
        "properties": {
            "Name": {"title": [{"text": {"content": title}}]},
            "Status": {"select": {"name": "Open"}},
            "Type": {"multi_select": [{"name": "WordFlux"}]},
        },
        "children": [{
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": body_text[:2000]}}]
            }
        }] if body_text else [],
    })


# ── File / subprocess helpers ─────────────────────────────────────────────────

def download_file(url, dest):
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "OpenDia-intake/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())
    return str(dest)


def screenshot_url(url, out_path):
    """Playwright full-page screenshot at 1280×800."""
    script = (
        "import asyncio\n"
        "from playwright.async_api import async_playwright\n"
        "async def _run():\n"
        "    async with async_playwright() as p:\n"
        "        b = await p.chromium.launch()\n"
        "        pg = await b.new_page(viewport={'width':1280,'height':800})\n"
        f"        await pg.goto({url!r}, timeout=15000)\n"
        f"        await pg.screenshot(path={str(out_path)!r}, full_page=True)\n"
        "        await b.close()\n"
        "asyncio.run(_run())\n"
    )
    result = subprocess.run(["python3", "-c", script], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"playwright failed: {result.stderr[:250]}")
    return str(out_path)


def run_nano_banana(prompt, out_path, reference_paths=None):
    """Call nano_banana.py. Returns saved image path."""
    cmd = ["python3", str(SCRIPTS_DIR / "nano_banana.py"), prompt, "--out", str(out_path)]
    for ref in (reference_paths or []):
        cmd += ["--reference", str(ref)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"nano_banana: {r.stderr[:300]}")
    return r.stdout.strip() or str(out_path)


def run_edit_field(repo_path, file_rel, field, value):
    """Call edit-field.py inside repo to patch a scalar JSON/MD-frontmatter field."""
    ef = Path(repo_path) / "scripts" / "edit-field.py"
    target = Path(repo_path) / file_rel
    r = subprocess.run(
        ["python3", str(ef), str(target), field, str(value)],
        capture_output=True, text=True, cwd=str(repo_path),
    )
    if r.returncode != 0:
        raise RuntimeError(f"edit-field {file_rel}/{field}: {r.stderr[:250]}")


def sed_replace(path, pattern, replacement):
    p = Path(path)
    text = p.read_text()
    if not re.search(pattern, text):
        raise ValueError(f"sed_replace: pattern not found in {path}: {pattern!r}")
    new_text = re.sub(pattern, lambda m: replacement, text)
    if new_text != text:
        p.write_text(new_text)


def _patch_json_array(json_path, field, value):
    with open(json_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    data[field] = value
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def _parse_social_links(raw):
    links = []
    for line in (raw or "").strip().splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        platform, _, url = line.partition(":")
        url = url.strip()
        if url.startswith("http"):
            links.append({"platform": platform.strip().lower(), "url": url})
    return links


def _fmt_phone_display(raw):
    """Format raw phone string as (NXX) NXX-XXXX. Returns raw if can't parse 10 digits."""
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("1") and len(digits) == 11:
        digits = digits[1:]
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    return raw or ""


def _find_frontmatter_end(path):
    """Return the line count (exclusive) of the closing --- of YAML frontmatter."""
    lines = Path(path).read_text().splitlines(keepends=True)
    if not lines or not lines[0].startswith("---"):
        return 0
    for i, line in enumerate(lines[1:], 1):
        if line.startswith("---"):
            return i + 1
    return len(lines)


def _replace_template_placeholders(repo_path, replacements):
    """Replace template placeholder strings across all content files."""
    patterns = (
        "src/content/**/*.md",
        "src/content/**/*.json",
        "src/pages/**/*.astro",
        "src/components/*.astro",
    )
    for pattern in patterns:
        for fpath in Path(repo_path).glob(pattern):
            text = fpath.read_text()
            changed = False
            for old, new in replacements:
                if old and new and old in text:
                    text = text.replace(old, new)
                    changed = True
            if changed:
                fpath.write_text(text)


def _generate_text_logo(biz_name, primary_hex, dest_path):
    """Generate a simple SVG text logo from the business name and brand color."""
    safe_name = biz_name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    width = max(180, len(biz_name) * 18 + 40)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 52" width="{width}" height="52">'
        f'<text x="0" y="38" font-family="system-ui, -apple-system, sans-serif" '
        f'font-size="32" font-weight="700" fill="{primary_hex}" letter-spacing="-0.02em">'
        f'{safe_name}</text></svg>'
    )
    Path(dest_path).write_text(svg)


def _git(cmd, cwd):
    env = {**os.environ,
           "GIT_SSH_COMMAND": "ssh -i ~/.ssh/gitlab_opendia -o StrictHostKeyChecking=accept-new"}
    r = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"git {cmd[1]}: {r.stderr[:300]}")
    return r.stdout.strip()


def gmail_draft_to_nick(subject, body):
    sys.path.insert(0, str(SCRIPTS_DIR))
    from gmail_helper import _load_service, create_draft
    service = _load_service()
    return create_draft(service, "nick@linnflux.com", subject, body)


# ── Stage 1 + 2 + 4: triage_lead ─────────────────────────────────────────────

def triage_lead(submission):
    """Process a 68QDQA submission: inbox row, design research, Nick draft."""
    sid = submission["id"]
    f = normalize(submission, FIELD_MAP_68QDQA)

    biz_name   = (f.get("biz_name") or f.get("name") or "Unknown").strip()
    email      = (f.get("email") or "").strip()
    phone      = (f.get("phone") or "").strip()
    name       = (f.get("name") or "").strip()
    site_type_raw = first_label(f.get("site_type")) or "Something else"
    variant    = VARIANT_MAP.get(site_type_raw, "fluxcc")
    design_desc = f.get("design_description") or ""
    admired_raw = f.get("admired_urls") or ""
    biz_desc   = f.get("biz_description") or ""
    design_intent = first_label(f.get("design_intent")) or ""
    content_intent = first_label(f.get("content_intent")) or ""
    pages_needed  = f.get("pages_needed") or []
    uploaded_designs = file_mimes(f.get("uploaded_designs"))

    # ── Stage 1: slug, inbox row, Registry row, Notion task ──
    gmail_id = f"tally:{FORM_68QDQA}:{sid}"

    # Re-run safety: reuse slug if row already exists
    existing_row = get_inbox_row_by_gmail_id(gmail_id)
    if existing_row:
        slug = existing_row["client_hint"]
    else:
        base_slug = slugify(biz_name)
        slug = unique_slug(base_slug, exclude_gmail_id=gmail_id)

    notes = (f"tally:{FORM_68QDQA} submission_id={sid}; "
             f"variant={variant}; site_type={site_type_raw}")
    inbox_id = upsert_inbox_row(
        gmail_id=gmail_id, from_addr=email,
        subject=f"[intake] {biz_name}", status="new-lead",
        client_hint=slug, division_hint="WordFlux", notes=notes,
    )
    print(f"  inbox row id={inbox_id} slug={slug}")

    # Build Registry
    try:
        if not find_registry_row_id(slug):
            append_registry_row(client=biz_name, slug=slug, status="lead")
            print(f"  Registry row appended: {slug}")
        else:
            print(f"  Registry row already exists: {slug}")
    except Exception as e:
        print(f"  [warn] Registry: {e}", file=sys.stderr)

    # Notion task
    task_url = ""
    try:
        task_body = (
            f"Lead from Tally 68QDQA\n"
            f"Contact: {name} <{email}> {phone}\n"
            f"Business: {biz_name}\n"
            f"Site type: {site_type_raw} → template: {variant}\n"
            f"Design intent: {design_intent}\n"
            f"Design description: {design_desc}\n"
            f"Business description: {biz_desc}\n"
            f"Pages: {', '.join(pages_needed) if isinstance(pages_needed, list) else pages_needed}\n"
            f"Inbox row id: {inbox_id} | Submission: {sid}\n"
            f"Next step: Send QKBRQl link manually with pre-fill params."
        )
        task_page = create_notion_task(f"New lead: {biz_name}", task_body)
        task_url = task_page.get("url", "")
        print(f"  Notion task: {task_url}")
    except Exception as e:
        print(f"  [warn] Notion task: {e}", file=sys.stderr)

    # ── Stage 2: Design research ──
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    ref_paths = []
    png_paths = []

    if uploaded_designs:
        # Skip generation — download uploads instead
        for i, (url, mime) in enumerate(uploaded_designs[:3]):
            ext = ".svg" if "svg" in mime else ".png" if "png" in mime else ".jpg"
            dest = DEBUG_DIR / f"intake-{slug}-upload-{i+1}{ext}"
            try:
                download_file(url, dest)
                ref_paths.append(str(dest))
                png_paths.append(str(dest))
                print(f"  Upload {i+1} → {dest}")
            except Exception as e:
                print(f"  [warn] upload download: {e}", file=sys.stderr)
    else:
        # Screenshot admired URLs
        url_list = [
            u.strip()
            for u in re.split(r"[\n,]+", admired_raw)
            if u.strip().startswith("http")
        ]
        for i, url in enumerate(url_list[:3], 1):
            ref_path = DEBUG_DIR / f"intake-{slug}-ref-{i}.png"
            try:
                screenshot_url(url, str(ref_path))
                ref_paths.append(str(ref_path))
                print(f"  Screenshot {i} → {ref_path}")
            except Exception as e:
                print(f"  [warn] screenshot {url}: {e}", file=sys.stderr)

        # 2-3 Nano Banana mockups
        site_label = site_type_raw.lower().replace(" / ", " ")
        prompts = [
            (f"A modern website hero section mockup for a {site_label} business called "
             f"'{biz_name}'. Style: {design_desc or 'clean and professional'}. "
             f"Full-width web layout, realistic browser render."),
            (f"Homepage wireframe mockup for '{biz_name}', a {site_label}. "
             f"Visual style: {design_desc or 'contemporary'}. "
             f"Show nav bar, hero, and one content section."),
        ]
        if biz_desc:
            prompts.append(
                f"Brand mood board for '{biz_name}': {biz_desc}. "
                f"Style direction: {design_desc or 'professional'}. "
                f"Color palette, typography, and visual feel."
            )
        for i, prompt in enumerate(prompts, 1):
            out = DEBUG_DIR / f"intake-{slug}-{ts}-{i}.png"
            try:
                path = run_nano_banana(prompt, out, reference_paths=ref_paths or None)
                png_paths.append(path)
                print(f"  Nano Banana {i} → {path}")
            except Exception as e:
                print(f"  [warn] nano_banana {i}: {e}", file=sys.stderr)

    # ── Stage 4: Draft to Nick ──
    qkbrql_url = (
        f"https://tally.so/r/QKBRQl"
        f"?XG9JPz={urllib.parse.quote(biz_name)}"
        f"&0MGBRA={urllib.parse.quote(email)}"
    )
    pages_str = (", ".join(pages_needed) if isinstance(pages_needed, list)
                 else str(pages_needed or ""))
    png_lines = "\n".join(f"  {p}" for p in png_paths) if png_paths else "  (none)"
    body = (
        f"New flux.cc lead arrived.\n\n"
        f"Contact: {name}\n"
        f"Email: {email}\n"
        f"Phone: {phone or '(not provided)'}\n"
        f"Business: {biz_name}\n"
        f"Description: {biz_desc or '(not provided)'}\n\n"
        f"Site type: {site_type_raw}\n"
        f"Template: {variant}\n"
        f"Design intent: {design_intent or '(not specified)'}\n"
        f"Design description: {design_desc or '(not provided)'}\n"
        f"Content intent: {content_intent or '(not specified)'}\n"
        f"Pages needed: {pages_str or '(not specified)'}\n\n"
        f"Admired URLs: {admired_raw.strip() or '(none)'}\n\n"
        f"Design mockups:\n{png_lines}\n\n"
        f"Notion task: {task_url or '(creation failed)'}\n"
        f"Build Registry: https://www.notion.so/{BUILD_REGISTRY_TABLE_ID.replace('-','')}\n\n"
        f"ACTION REQUIRED: Send QKBRQl link to {name or email} manually:\n"
        f"{qkbrql_url}\n\n"
        f"(Stage 3 — auto-draft to lead — is skipped. Manual follow-up only.)\n"
        f"Inbox row id: {inbox_id} | Submission: {sid}"
    )
    try:
        gmail_draft_to_nick(f"[flux.cc] New lead: {biz_name}", body)
        print(f"  Draft created: [flux.cc] New lead: {biz_name}")
    except Exception as e:
        print(f"  [warn] Gmail draft: {e}", file=sys.stderr)

    print(f"  triage_lead OK: slug={slug} variant={variant}")
    return slug, variant


# ── Stage 5-8: scaffold_from_intake ──────────────────────────────────────────

def scaffold_from_intake(submission):
    """Process a QKBRQl submission: scaffold repo, CF Pages, hero image, notify Nick."""
    f = normalize(submission, FIELD_MAP_QKBRQL)
    email    = (f.get("email") or "").strip()
    biz_name = (f.get("biz_name") or "Unknown").strip()

    # ── Stage 5: match to prior 68QDQA lead ──
    lead_row = find_lead_by_email(email)
    if not lead_row:
        raise ValueError(
            f"QKBRQl submission has no matching 68QDQA lead for email={email!r}"
        )

    slug = lead_row["client_hint"]
    gmail_id_lead = lead_row["gmail_id"]
    lead_notes = lead_row.get("notes") or ""
    lead_subject = lead_row.get("subject") or f"[intake] {biz_name}"

    m = re.search(r"variant=([a-z-]+)", lead_notes)
    variant = m.group(1) if m else "fluxcc-business"

    print(f"  Matched lead: slug={slug} variant={variant}")

    # Upgrade status
    upsert_inbox_row(
        gmail_id=gmail_id_lead, from_addr=email,
        subject=lead_subject, status="scaffolding",
        client_hint=slug, notes=lead_notes,
    )
    registry_row_id = find_registry_row_id(slug)
    if registry_row_id:
        try:
            update_registry_row(registry_row_id, status="scaffolding")
        except Exception as e:
            print(f"  [warn] Registry scaffolding: {e}", file=sys.stderr)

    # ── Stage 6: scaffold dev environment ──
    repo_path = REPOS_ROOT / slug
    template_origin = f"git@gitlab.com:flux-cc/{variant}.git"

    if not (repo_path / ".git").exists():
        print(f"  Cloning {template_origin}...")
        _git(["git", "clone", template_origin, str(repo_path)], REPOS_ROOT)
    else:
        print(f"  Repo already exists at {repo_path}")

    # Scalar data.json fields via edit-field.py
    data_json = "src/content/business/data.json"
    scalars = {
        "name": biz_name,
        "tagline": f.get("tagline"),
        "phone": f.get("phone"),
        "email": email,
        "hours": f.get("hours"),
    }
    addr_parts = [f.get("address"), f.get("city"), f.get("state"), f.get("zip")]
    addr = ", ".join(p for p in addr_parts if p)
    if addr:
        scalars["address"] = addr

    for field, val in scalars.items():
        if val:
            try:
                run_edit_field(repo_path, data_json, field, val)
            except Exception as e:
                print(f"  [warn] edit-field {field}: {e}", file=sys.stderr)

    # Array field: socialLinks (must use direct JSON edit)
    social_raw = f.get("social_links") or ""
    if social_raw:
        links = _parse_social_links(social_raw)
        if links:
            try:
                _patch_json_array(repo_path / data_json, "socialLinks", links)
            except Exception as e:
                print(f"  [warn] socialLinks patch: {e}", file=sys.stderr)

    # home.md frontmatter
    home_md = "src/content/pages/home.md"
    elevator_pitch = f.get("elevator_pitch")
    if elevator_pitch and len(elevator_pitch) > 160:
        elevator_pitch = elevator_pitch[:157].rsplit(" ", 1)[0] + "..."
    for field, val in [("heroHeading", f.get("hero_heading")),
                        ("heroSubheading", f.get("hero_subheading")),
                        ("description", elevator_pitch)]:
        if val:
            try:
                run_edit_field(repo_path, home_md, field, val)
            except Exception as e:
                print(f"  [warn] {field}: {e}", file=sys.stderr)

    # ── Content placeholder replacement ──
    phone_raw    = f.get("phone") or ""
    phone_fmt    = _fmt_phone_display(phone_raw)
    phone_dig    = re.sub(r"\D", "", phone_raw)
    if phone_dig.startswith("1") and len(phone_dig) == 11:
        phone_dig = phone_dig[1:]
    city         = (f.get("city") or "").strip()
    state        = (f.get("state") or "").strip()
    service_area = (f.get("service_area") or city or "").strip()
    city_state   = f"{city}, {state}" if city and state else service_area or biz_name

    placeholder_values = {
        "business_name": biz_name,
        "city_state":    city_state,
        "city":          city or biz_name,
        "phone_display": phone_fmt,
        "phone_digits":  phone_dig,
        "service_area":  service_area or city or biz_name,
        "state":         state,
        "email":         email,
    }
    manifest_path = repo_path / "scripts" / "placeholders.json"
    replacements = []
    if manifest_path.exists():
        try:
            # JSON object order is preserved; manifests list longer/more-specific
            # strings first so e.g. "Anytown, NY" is replaced before "Anytown".
            manifest = json.loads(manifest_path.read_text())
            for old, key in manifest.items():
                new = placeholder_values.get(key, "")
                if new:
                    replacements.append((old, new))
        except Exception as e:
            print(f"  [warn] placeholders.json: {e}", file=sys.stderr)
    if not replacements:
        replacements = [
            ("Joe's Plumbing",  biz_name),
            ("Anytown, NY",     city_state),
            ("Anytown",         city or biz_name),
            ("(555) 123-4567",  phone_fmt),
            ("5551234567",      phone_dig),
            ("[County] County", service_area or city or biz_name),
            # State replacements — more specific first
            ("New York State",  state or "New York State"),
            ("New York",        state or "New York"),
        ]
    try:
        _replace_template_placeholders(repo_path, replacements)
        print(f"  Template placeholders replaced.")
    except Exception as e:
        print(f"  [warn] placeholder replacement: {e}", file=sys.stderr)
    checker = repo_path / "scripts" / "check-banned-words.mjs"
    if checker.exists():
        r = subprocess.run(["node", str(checker)], cwd=str(repo_path),
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  [warn] banned-words check:\n{r.stdout}{r.stderr}", file=sys.stderr)

    # about.md frontmatter
    about_md = "src/content/pages/about.md"
    tagline = f.get("tagline") or ""
    about_desc = f"{biz_name} — {tagline}" if tagline else f"Learn about {biz_name}."
    for field, val in [("description", about_desc),
                       ("heroHeading",  f"About {biz_name}")]:
        try:
            run_edit_field(repo_path, about_md, field, val)
        except Exception as e:
            print(f"  [warn] about.md {field}: {e}", file=sys.stderr)
    if f.get("about_paragraphs"):
        about_path = repo_path / about_md
        fm_end = _find_frontmatter_end(about_path)
        try:
            lines = about_path.read_text().splitlines(keepends=True)
            about_path.write_text("".join(lines[:fm_end]) + "\n" + f.get("about_paragraphs").strip() + "\n")
            print(f"  about.md body injected.")
        except Exception as e:
            print(f"  [warn] about.md body: {e}", file=sys.stderr)

    # services.md frontmatter
    services_md = "src/content/pages/services.md"
    svc_desc = f"{biz_name} services in {city}, {state}." if city and state else f"{biz_name} services."
    try:
        run_edit_field(repo_path, services_md, "description", svc_desc)
    except Exception as e:
        print(f"  [warn] services.md description: {e}", file=sys.stderr)
    services_body = f.get("services_block") or f.get("services_content")
    if services_body:
        svc_path = repo_path / services_md
        fm_end = _find_frontmatter_end(svc_path)
        try:
            lines = svc_path.read_text().splitlines(keepends=True)
            svc_path.write_text("".join(lines[:fm_end]) + "\n" + services_body.strip() + "\n")
            print(f"  services.md body injected.")
        except Exception as e:
            print(f"  [warn] services.md body: {e}", file=sys.stderr)

    # contact.md frontmatter
    contact_md = "src/content/pages/contact.md"
    contact_desc = f"Contact {biz_name}" + (f" in {city}, {state}." if city and state else ".")
    try:
        run_edit_field(repo_path, contact_md, "description", contact_desc)
    except Exception as e:
        print(f"  [warn] contact.md description: {e}", file=sys.stderr)
    if f.get("tally_contact_id"):
        try:
            run_edit_field(repo_path, contact_md, "tallyFormId", f.get("tally_contact_id"))
        except Exception as e:
            print(f"  [warn] contact.md tallyFormId: {e}", file=sys.stderr)
    if f.get("maps_url"):
        try:
            run_edit_field(repo_path, contact_md, "mapEmbedUrl", f.get("maps_url"))
        except Exception as e:
            print(f"  [warn] contact.md mapEmbedUrl: {e}", file=sys.stderr)

    # global.css color tokens
    css_path = repo_path / "src" / "styles" / "global.css"
    if css_path.exists():
        for css_var, tally_key in [("--color-primary",    "primary_hex"),
                                    ("--color-accent",     "accent_hex"),
                                    ("--color-accent-dk",  "accent_dark_hex")]:
            hex_val = (f.get(tally_key) or "").strip()
            if hex_val.startswith("#"):
                try:
                    text = css_path.read_text()
                    new_text = re.sub(
                        rf"({re.escape(css_var)}:\s*)#[0-9a-fA-F]{{3,8}}",
                        rf"\g<1>{hex_val}",
                        text,
                    )
                    if new_text != text:
                        css_path.write_text(new_text)
                        print(f"  CSS {css_var} → {hex_val}")
                except Exception as e:
                    print(f"  [warn] css {css_var}: {e}", file=sys.stderr)

    # astro.config.mjs site URL
    try:
        sed_replace(repo_path / "astro.config.mjs",
                    r"site:\s*'[^']*'",
                    f"site: 'https://{slug}.pages.dev'")
    except Exception as e:
        print(f"  [warn] astro.config.mjs: {e}", file=sys.stderr)

    # .gitlab-ci.yml --project-name
    try:
        sed_replace(repo_path / ".gitlab-ci.yml",
                    r"--project-name=\S+",
                    f"--project-name={slug}")
    except Exception as e:
        print(f"  [warn] .gitlab-ci.yml: {e}", file=sys.stderr)

    # package.json name
    try:
        run_edit_field(repo_path, "package.json", "name", slug)
    except Exception as e:
        print(f"  [warn] package.json name: {e}", file=sys.stderr)

    # Download uploads
    img_dir = repo_path / "public" / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    logo_local = None

    logo_files = file_mimes(f.get("logo"))
    if logo_files:
        url, mime = logo_files[0]
        ext = ".svg" if "svg" in mime else ".png"
        dest = img_dir / f"logo{ext}"
        try:
            download_file(url, dest); logo_local = str(dest)
            print(f"  Logo → {dest}")
        except Exception as e:
            print(f"  [warn] logo: {e}", file=sys.stderr)

    # If no logo uploaded, generate SVG text logo
    if not logo_local:
        primary_hex_val = f.get("primary_hex") or "#2d3748"
        text_logo_path = img_dir / "logo.svg"
        try:
            _generate_text_logo(biz_name, primary_hex_val, text_logo_path)
            logo_local = str(text_logo_path)
            print(f"  Text logo generated → {text_logo_path}")
        except Exception as e:
            print(f"  [warn] text logo: {e}", file=sys.stderr)

    # Update data.json logo path if SVG (fixes bug when client uploads SVG)
    if logo_local and logo_local.endswith(".svg"):
        try:
            run_edit_field(repo_path, data_json, "logo", "/images/logo.svg")
        except Exception as e:
            print(f"  [warn] data.json logo path: {e}", file=sys.stderr)

    favicon_files = file_mimes(f.get("favicon"))
    if favicon_files:
        url, mime = favicon_files[0]
        ext = ".svg" if "svg" in mime else ".ico" if "ico" in mime else ".png"
        try:
            download_file(url, img_dir / f"favicon{ext}")
        except Exception as e:
            print(f"  [warn] favicon: {e}", file=sys.stderr)

    og_files = file_mimes(f.get("og_image"))
    if og_files:
        url, mime = og_files[0]
        ext = ".jpg" if "jpg" in mime or "jpeg" in mime else ".png"
        try:
            download_file(url, img_dir / f"og-image{ext}")
        except Exception as e:
            print(f"  [warn] og-image: {e}", file=sys.stderr)

    # Create GitLab repo
    gitlab_repo = f"flux-cc/{slug}"
    cf_api_key = load_cf_api_key()
    gitlab_token = load_gitlab_token()

    print(f"  Creating GitLab repo {gitlab_repo}...")
    r = subprocess.run(
        [str(GLAB_PATH), "repo", "create", gitlab_repo,
         "--internal", "--defaultBranch", "main"],
        capture_output=True, text=True,
        env={**os.environ, "GITLAB_TOKEN": gitlab_token},
    )
    if r.returncode != 0 and "already exists" not in (r.stdout + r.stderr):
        print(f"  [warn] glab repo create: {r.stderr[:200]}", file=sys.stderr)
    else:
        print(f"  GitLab repo: https://gitlab.com/{gitlab_repo}")

    # Create CF Pages project (idempotent — check existence first)
    cf_env = {**os.environ, "CLOUDFLARE_API_KEY": cf_api_key, "CLOUDFLARE_EMAIL": CF_EMAIL}
    list_r = subprocess.run(
        ["npx", "wrangler", "pages", "project", "list"],
        capture_output=True, text=True, env=cf_env,
    )
    if slug in list_r.stdout:
        print(f"  CF Pages project already exists: {slug}.pages.dev")
    else:
        print(f"  Creating CF Pages project {slug}...")
        r = subprocess.run(
            ["npx", "wrangler", "pages", "project", "create",
             slug, "--production-branch", "main"],
            capture_output=True, text=True, env=cf_env,
        )
        if r.returncode != 0:
            print(f"  [warn] CF Pages create: {r.stderr[:200]}", file=sys.stderr)
        else:
            print(f"  CF Pages: https://{slug}.pages.dev")

    # Set GitLab CI var CF_API_KEY
    r = subprocess.run(
        [str(GLAB_PATH), "variable", "set", "CF_API_KEY",
         "--value", cf_api_key, "--repo", gitlab_repo],
        capture_output=True, text=True,
        env={**os.environ, "GITLAB_TOKEN": gitlab_token},
    )
    if r.returncode != 0:
        print(f"  [warn] glab variable set: {r.stderr[:150]}", file=sys.stderr)

    # Push to new remote
    try:
        _git(["git", "remote", "set-url", "origin",
               f"git@gitlab.com:{gitlab_repo}.git"], repo_path)
    except Exception:
        _git(["git", "remote", "add", "origin",
               f"git@gitlab.com:{gitlab_repo}.git"], repo_path)

    _git(["git", "add", "."], repo_path)
    try:
        _git(["git", "commit", "-m", f"scaffold: {biz_name}"], repo_path)
    except Exception:
        pass  # Nothing to commit
    _git(["git", "push", "-u", "origin", "main", "--force"], repo_path)
    print("  Pushed to GitLab — CF Pages build triggered.")

    # Update Registry
    if registry_row_id:
        try:
            update_registry_row(
                registry_row_id,
                status="scaffolded",
                cf_project=slug,
                preview_url=f"{slug}.pages.dev",
                gitlab_repo=gitlab_repo,
            )
        except Exception as e:
            print(f"  [warn] Registry scaffolded: {e}", file=sys.stderr)

    # ── Stage 7: First-draft design pass ──
    primary_hex = f.get("primary_hex") or "#2d3748"
    accent_hex  = f.get("accent_hex") or "#4a90e2"
    hero_prompt = (
        f"Full-width website hero background image for '{biz_name}'. "
        f"Primary brand color: {primary_hex}, accent: {accent_hex}. "
        f"Style: {f.get('design_description') or 'professional and clean'}. "
        f"Business: {f.get('elevator_pitch') or biz_desc or biz_name}. "
        f"1920x600 pixels, no text, suitable as hero background."
    )
    hero_out = img_dir / "hero.png"
    hero_path = None
    try:
        hero_path = run_nano_banana(
            hero_prompt, hero_out,
            reference_paths=[logo_local] if logo_local else None,
        )
        print(f"  Hero image → {hero_path}")
    except Exception as e:
        print(f"  [warn] hero image: {e}", file=sys.stderr)

    _git(["git", "add", "."], repo_path)
    try:
        _git(["git", "commit", "-m", "first-draft design pass"], repo_path)
        _git(["git", "push"], repo_path)
    except Exception:
        pass  # Nothing new

    # Update status → first-draft
    upsert_inbox_row(
        gmail_id=gmail_id_lead, from_addr=email,
        subject=lead_subject, status="first-draft",
        client_hint=slug, notes=lead_notes,
    )
    if registry_row_id:
        try:
            update_registry_row(registry_row_id, status="first-draft")
        except Exception as e:
            print(f"  [warn] Registry first-draft: {e}", file=sys.stderr)

    # ── Stage 8: Final notification draft ──
    placeholders = []
    if not f.get("tagline"):       placeholders.append("tagline")
    if not f.get("hours"):         placeholders.append("hours")
    if not logo_files:             placeholders.append("logo")
    if not og_files and not hero_path: placeholders.append("og-image")
    if not f.get("about_paragraphs"):  placeholders.append("about_paragraphs")
    if not (f.get("services_block") or f.get("services_content")):
                                   placeholders.append("services_content")
    if not f.get("tally_contact_id"):  placeholders.append("tally_contact_id")
    if not f.get("maps_url"):          placeholders.append("maps_url")
    if not f.get("primary_hex"):       placeholders.append("primary_hex")

    body8 = (
        f"First draft ready for {biz_name}.\n\n"
        f"Contact: {f.get('name', '')} <{email}>\n"
        f"Phone: {f.get('phone') or '(not provided)'}\n\n"
        f"GitLab: https://gitlab.com/{gitlab_repo}\n"
        f"Preview: https://{slug}.pages.dev\n"
        f"Build Registry: https://www.notion.so/{BUILD_REGISTRY_TABLE_ID.replace('-','')}\n\n"
        f"Fields substituted: name, phone, email, address, hours, hero heading/subheading,\n"
        f"  primary_hex ({primary_hex}), accent_hex ({accent_hex})\n"
        f"Placeholders remaining: {', '.join(placeholders) if placeholders else 'none'}\n\n"
        f"Hero image: {hero_path or '(generation failed)'}\n\n"
        f"Template: {variant} | Slug: {slug}"
    )
    try:
        gmail_draft_to_nick(f"[flux.cc] First draft ready: {biz_name}", body8)
        print(f"  Draft created: [flux.cc] First draft ready: {biz_name}")
    except Exception as e:
        print(f"  [warn] Gmail draft stage 8: {e}", file=sys.stderr)

    print(f"  scaffold_from_intake OK: slug={slug} repo={gitlab_repo}")


# ── Poll ─────────────────────────────────────────────────────────────────────

def _process_form(form_id, field_map, handler, seen, submissions_override=None):
    """Fetch + process all new submissions for a form."""
    if submissions_override is not None:
        subs = submissions_override
    else:
        subs = fetch_submissions_api(form_id)
    print(f"  {form_id}: {len(subs)} submissions")
    for sub in subs:
        sid = sub["id"]
        if is_seen(seen, form_id, sid):
            continue
        print(f"  Processing {form_id}/{sid}...")
        try:
            handler(sub)
            mark_seen(seen, form_id, sid)
        except Exception:
            tb = traceback.format_exc()
            print(f"  ERROR {form_id}/{sid}:\n{tb}", file=sys.stderr)
            f = normalize(sub, field_map)
            biz = (f.get("biz_name") or f.get("name") or "unknown").strip()
            gmail_id = f"tally:{form_id}:{sid}"
            upsert_inbox_row(
                gmail_id=gmail_id, from_addr=f.get("email") or "",
                subject=f"[intake] {biz}",
                status="error", client_hint=slugify(biz),
                notes=f"tally:{form_id} submission_id={sid}",
                error_text=tb[:2000],
            )
            mark_seen(seen, form_id, sid)


def poll(fixture_path=None):
    seen = load_seen()
    print(f"[intake-poll] {datetime.now().isoformat()}")

    fixture_68 = fixture_qk = None
    if fixture_path:
        with open(fixture_path) as fh:
            fx = json.load(fh)
        fixture_68 = fx.get(FORM_68QDQA, [])
        fixture_qk = fx.get(FORM_QKBRQL, [])
        print(f"  Fixture mode: {len(fixture_68)} 68QDQA, {len(fixture_qk)} QKBRQl")

    # 68QDQA
    try:
        _process_form(FORM_68QDQA, FIELD_MAP_68QDQA, triage_lead, seen,
                      submissions_override=fixture_68)
    except FileNotFoundError as e:
        print(f"  [skip 68QDQA] {e}", file=sys.stderr)
    except Exception:
        print(f"  ERROR polling 68QDQA:\n{traceback.format_exc()}", file=sys.stderr)

    # QKBRQl
    try:
        _process_form(FORM_QKBRQL, FIELD_MAP_QKBRQL, scaffold_from_intake, seen,
                      submissions_override=fixture_qk)
    except FileNotFoundError as e:
        print(f"  [skip QKBRQl] {e}", file=sys.stderr)
    except Exception:
        print(f"  ERROR polling QKBRQl:\n{traceback.format_exc()}", file=sys.stderr)

    print("[intake-poll] done.")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FluxCC Intake Pipeline")
    sub = parser.add_subparsers(dest="command")

    p_poll = sub.add_parser("poll")
    p_poll.add_argument("--fixture", metavar="FILE",
                        help="JSON fixture file instead of live Tally API")

    p_triage = sub.add_parser("triage-lead")
    p_triage.add_argument("submission_id")

    p_scaffold = sub.add_parser("scaffold-from-intake")
    p_scaffold.add_argument("submission_id")

    args = parser.parse_args()

    if args.command == "poll":
        poll(fixture_path=args.fixture)
    elif args.command == "triage-lead":
        subs = fetch_submissions_api(FORM_68QDQA)
        sub_map = {s["id"]: s for s in subs}
        if args.submission_id not in sub_map:
            sys.exit(f"Submission {args.submission_id} not found in {FORM_68QDQA}")
        triage_lead(sub_map[args.submission_id])
    elif args.command == "scaffold-from-intake":
        subs = fetch_submissions_api(FORM_QKBRQL)
        sub_map = {s["id"]: s for s in subs}
        if args.submission_id not in sub_map:
            sys.exit(f"Submission {args.submission_id} not found in {FORM_QKBRQL}")
        scaffold_from_intake(sub_map[args.submission_id])
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
