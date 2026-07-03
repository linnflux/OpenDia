#!/usr/bin/env bash
# migrate-export.sh — Export OpenDia + Claude configs to Google Drive
# Run on the CURRENT machine before migrating to a new one.
# Non-destructive: only copies to Google Drive, nothing is deleted locally.

set -euo pipefail

OPENDIA_DIR="$HOME/OpenDia"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[x]${NC} $*"; exit 1; }

# --- Preflight ---
command -v rclone >/dev/null || fail "rclone not found. Install with: sudo apt install rclone"
rclone listremotes | grep -q '^gdrive:$' || fail "'gdrive' remote not configured. Run: rclone config"

# --- Step 1: Generate requirements.txt from venv ---
info "Generating requirements.txt from venv..."
if [ -d "$OPENDIA_DIR/venv" ]; then
    "$OPENDIA_DIR/venv/bin/pip" freeze > "$OPENDIA_DIR/requirements.txt"
    info "  Wrote $(wc -l < "$OPENDIA_DIR/requirements.txt") packages to requirements.txt"
else
    warn "  No venv found at $OPENDIA_DIR/venv — skipping requirements.txt"
fi

# --- Step 2: Sync Claude configs to Google Drive (existing od-sync filter) ---
info "Syncing ~/.claude/ to gdrive:Claude-Config/ ..."

CLAUDE_FILTER=$(mktemp)
cat > "$CLAUDE_FILTER" <<'FILTER'
+ CLAUDE.md
+ INSTALL.md
+ .claude.json
+ settings.json
+ settings.local.json
+ keybindings.json
+ commands/**
+ agents/**
+ skills/**
+ plugins/**
+ hooks/**
+ logs/**
+ memory/**
+ plans/**
- mcp-servers/**/node_modules/**
- mcp-servers/**/package-lock.json
+ mcp-servers/**/src/**
+ mcp-servers/**/package.json
+ mcp-servers/**/tsconfig.json
+ mcp-servers/**/README.md
+ mcp-servers/**/dist/**
+ mcp-servers/**/build.mjs
+ mcp-servers/**/.gitignore
+ mcp-servers/**/.git/**
- .credentials.json
- mcp-credentials/**
- projects/**/*.jsonl
- projects/**/subagents/**
- projects/**/tool-results/**
- projects/**/sessions-index.json
+ projects/**/memory/**
+ projects/**/CLAUDE.md
+ projects/**/settings.local.json
- projects/**
- cache/**
- statsig_cache.json
- *
FILTER

rclone sync "$CLAUDE_DIR/" "gdrive:Claude-Config/" \
    --filter-from "$CLAUDE_FILTER" \
    --tpslimit 8 --tpslimit-burst 8 \
    --retries 5 --low-level-retries 20 \
    -v 2>&1 | tail -5
rm -f "$CLAUDE_FILTER"

# --- Step 3: Copy .claude.json (root MCP config) into Drive ---
if [ -f "$CLAUDE_JSON" ]; then
    info "Syncing ~/.claude.json to gdrive:Claude-Config/.claude.json ..."
    rclone copyto "$CLAUDE_JSON" "gdrive:Claude-Config/.claude.json" -v 2>&1 | tail -3
fi

# --- Step 4: Dump crontab (picked up by rclone sync below) ---
info "Saving crontab snapshot..."
crontab -l > "$OPENDIA_DIR/crontab.backup" 2>/dev/null || true

# --- Step 4a: WAL-consistent SQLite snapshot ---
# opendia.db is in WAL mode; the main .db file may be stale.
# Python's sqlite3.backup() reads through the WAL and produces a full snapshot
# without modifying the source files.
info "Creating WAL-consistent SQLite snapshot..."
DB_LOCAL="$OPENDIA_DIR/opendia.db"
DB_SNAPSHOT="$OPENDIA_DIR/.opendia-backup-snapshot.db"
rm -f "$DB_SNAPSHOT"

if python3 - "$DB_LOCAL" "$DB_SNAPSHOT" <<'PYEOF'
import sys, sqlite3
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
PYEOF
then
    SNAPSHOT_SIZE=$(stat -c%s "$DB_SNAPSHOT" 2>/dev/null || echo 0)
    MAIN_SIZE=$(stat -c%s "$DB_LOCAL" 2>/dev/null || echo 0)
    info "  Snapshot: ${SNAPSHOT_SIZE} bytes (main file: ${MAIN_SIZE} bytes)"
    if [ "$SNAPSHOT_SIZE" -lt "$MAIN_SIZE" ]; then
        warn "  Snapshot (${SNAPSHOT_SIZE}B) is smaller than main db file (${MAIN_SIZE}B) — backup may be incomplete"
    fi
    if [ "$SNAPSHOT_SIZE" -lt 10000 ]; then
        fail "Snapshot is suspiciously tiny (${SNAPSHOT_SIZE} bytes) — aborting to protect Drive copy"
    fi
else
    fail "SQLite snapshot failed — aborting to protect Drive copy"
fi

# --- Step 4b: Versioned db backup ---
DB_STAMP=$(date +%Y%m%d)
DB_VERSIONED_KEY="gdrive:OpenDia/db-backups/opendia-${DB_STAMP}.db"
info "Versioned db backup → ${DB_VERSIONED_KEY} ..."
rclone copyto "$DB_SNAPSHOT" "$DB_VERSIONED_KEY" \
    --tpslimit 8 --tpslimit-burst 8 --retries 5 -v 2>&1 | tail -5

# Verify the dated file actually landed on Drive
if ! rclone lsf "$DB_VERSIONED_KEY" &>/dev/null; then
    warn "Versioned backup not confirmed on Drive after upload — check manually!"
fi

# Prune old versioned backups: keep the 14 most-recent dated files
info "Pruning old versioned backups (keeping 14)..."
rclone lsf "gdrive:OpenDia/db-backups/" --include "opendia-*.db" 2>/dev/null \
    | sort -r | tail -n +15 \
    | while read -r OLD; do
        info "  Deleting old backup: $OLD"
        rclone deletefile "gdrive:OpenDia/db-backups/$OLD" 2>/dev/null || true
    done

# --- Step 4: Sync OpenDia data to Google Drive ---
# opendia.db is excluded here; the WAL-consistent snapshot is uploaded below.
info "Syncing ~/OpenDia/ to gdrive:OpenDia/ ..."

OPENDIA_FILTER=$(mktemp)
cat > "$OPENDIA_FILTER" <<'FILTER'
- repo/**
- venv/**
- __pycache__/**
- *.pyc
- .wrangler/**
- **/node_modules/**
- **/.git/**
- **/dist/**
- **/.astro/**
- **/.next/**
- **/.cache/**
- db-backups/**
- .opendia-backup-snapshot.db
- opendia.db
- opendia.db-shm
- opendia.db-wal
+ **
FILTER

rclone sync "$OPENDIA_DIR/" "gdrive:OpenDia/" \
    --filter-from "$OPENDIA_FILTER" \
    --tpslimit 8 --tpslimit-burst 8 \
    --retries 5 --low-level-retries 20 \
    -v 2>&1 | tail -5
rm -f "$OPENDIA_FILTER"

# Upload the WAL-consistent snapshot as the canonical opendia.db on Drive
info "Uploading WAL-consistent snapshot as gdrive:OpenDia/opendia.db ..."
rclone copyto "$DB_SNAPSHOT" "gdrive:OpenDia/opendia.db" \
    --tpslimit 8 --tpslimit-burst 8 --retries 5 -v 2>&1 | tail -3
rm -f "$DB_SNAPSHOT"

# --- Step 4c: Verify Drive db matches snapshot size ---
DRIVE_SIZE=$(rclone size "gdrive:OpenDia/opendia.db" --json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('bytes',0))" 2>/dev/null || echo 0)
if [ "$DRIVE_SIZE" -ne "$SNAPSHOT_SIZE" ]; then
    warn "Drive db size (${DRIVE_SIZE} bytes) doesn't match snapshot (${SNAPSHOT_SIZE} bytes) — upload may have failed!"
else
    info "Drive db verified: ${DRIVE_SIZE} bytes (matches snapshot)"
fi

# --- Step 5: Sync FluxCC templates + client builds ---
info "Syncing ~/FluxCC/ to gdrive:FluxCC/ ..."

FLUXCC_DIR="$HOME/FluxCC"
if [ -d "$FLUXCC_DIR" ]; then
    rclone sync "$FLUXCC_DIR/" "gdrive:FluxCC/" \
        --exclude "node_modules/**" \
        --exclude "dist/**" \
        --exclude ".astro/**" \
        --exclude "package-lock.json" \
        --exclude ".git/**" \
        --tpslimit 8 --tpslimit-burst 8 \
        --retries 5 --low-level-retries 20 \
        -v 2>&1 | tail -5
else
    warn "~/FluxCC not found — skipping"
fi

# --- Success marker ---
# All real work is done at this point. Touch the marker BEFORE the cosmetic
# summary below: the recursive `rclone ls` listings occasionally get
# rate-limited after a long run, and with `set -euo pipefail` a failed listing
# used to kill the script here — leaving a stale marker despite every sync
# having completed and verified.
touch "$OPENDIA_DIR/logs/.last-backup-success"

# --- Summary (best-effort; failures here are non-fatal) ---
echo ""
info "Export complete. Drive contents:"
echo ""
for REMOTE in "Claude-Config" "OpenDia" "FluxCC"; do
    echo "  gdrive:${REMOTE}/"
    COUNT=$(rclone ls "gdrive:${REMOTE}/" --tpslimit 8 2>/dev/null | wc -l) || COUNT="?"
    echo "    ${COUNT} files"
    echo ""
done
info "Ready to run migrate-setup.sh on the new machine."
