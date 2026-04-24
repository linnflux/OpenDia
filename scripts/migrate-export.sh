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
    -v 2>&1 | tail -5
rm -f "$CLAUDE_FILTER"

# --- Step 3: Copy .claude.json (root MCP config) into Drive ---
if [ -f "$CLAUDE_JSON" ]; then
    info "Syncing ~/.claude.json to gdrive:Claude-Config/.claude.json ..."
    rclone copyto "$CLAUDE_JSON" "gdrive:Claude-Config/.claude.json" -v 2>&1 | tail -3
fi

# --- Step 4: Sync OpenDia data to Google Drive ---
info "Syncing ~/OpenDia/ to gdrive:OpenDia/ ..."

OPENDIA_FILTER=$(mktemp)
cat > "$OPENDIA_FILTER" <<'FILTER'
+ scripts/**
+ Time/**
+ Projects/**
+ Debug/**
+ www/**
+ opendia.db
+ requirements.txt
+ .claude/**
- venv/**
- __pycache__/**
- *.pyc
- *
FILTER

# --- Step 4b: Versioned db backup BEFORE sync (safety net) ---
DB_LOCAL="$OPENDIA_DIR/opendia.db"
DB_SIZE=$(stat -c%s "$DB_LOCAL" 2>/dev/null || echo 0)
if [ "$DB_SIZE" -gt 10000 ]; then
    DB_STAMP=$(date +%Y%m%d)
    info "Versioned db backup → gdrive:OpenDia/db-backups/opendia-${DB_STAMP}.db ..."
    rclone copyto "$DB_LOCAL" "gdrive:OpenDia/db-backups/opendia-${DB_STAMP}.db" 2>&1 | tail -2
    # Clean up backup copies older than 7 days
    rclone delete "gdrive:OpenDia/db-backups/" --min-age 7d 2>/dev/null || true
else
    warn "Local db looks empty or missing (${DB_SIZE} bytes) — skipping versioned backup and db sync"
    # Exclude opendia.db from the rclone sync below to protect Drive copy
    echo "- opendia.db" >> "$OPENDIA_FILTER"
fi

rclone sync "$OPENDIA_DIR/" "gdrive:OpenDia/" \
    --filter-from "$OPENDIA_FILTER" \
    -v 2>&1 | tail -5
rm -f "$OPENDIA_FILTER"

# --- Step 4c: Verify Drive db backup isn't empty ---
DRIVE_SIZE=$(rclone size "gdrive:OpenDia/opendia.db" --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('bytes',0))" 2>/dev/null || echo 0)
if [ "$DRIVE_SIZE" -lt 50000 ]; then
    warn "Drive db backup looks suspiciously small (${DRIVE_SIZE} bytes) — check immediately!"
else
    info "Drive db verified: ${DRIVE_SIZE} bytes"
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
        -v 2>&1 | tail -5
else
    warn "~/FluxCC not found — skipping"
fi

# --- Summary ---
echo ""
info "Export complete. Drive contents:"
echo ""
echo "  gdrive:Claude-Config/"
rclone ls "gdrive:Claude-Config/" 2>/dev/null | wc -l | xargs -I{} echo "    {} files"
echo ""
echo "  gdrive:OpenDia/"
rclone ls "gdrive:OpenDia/" 2>/dev/null | wc -l | xargs -I{} echo "    {} files"
echo ""
echo "  gdrive:FluxCC/"
rclone ls "gdrive:FluxCC/" 2>/dev/null | wc -l | xargs -I{} echo "    {} files"
echo ""
info "Ready to run migrate-setup.sh on the new machine."
