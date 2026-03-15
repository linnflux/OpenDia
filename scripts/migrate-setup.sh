#!/usr/bin/env bash
# migrate-setup.sh — Bootstrap OpenDia on a new LMDE7 machine
# Pulls everything from Google Drive (populated by migrate-export.sh)
# Run as your regular user (linnflux), NOT as root.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[x]${NC} $*"; exit 1; }
phase() { echo -e "\n${CYAN}=== Phase $1 ===${NC}\n"; }

PASS=0
FAIL=0
check_pass() { info "  PASS: $*"; ((PASS++)); }
check_fail() { warn "  FAIL: $*"; ((FAIL++)); }

# ============================================================
phase "A — Prerequisites"
# ============================================================

PACKAGES=(nodejs npm python3 python3-venv python3-pip chromium rclone curl git)
MISSING=()

for pkg in "${PACKAGES[@]}"; do
    if ! dpkg -s "$pkg" &>/dev/null; then
        MISSING+=("$pkg")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    info "Installing missing packages: ${MISSING[*]}"
    sudo apt update
    sudo apt install -y "${MISSING[@]}"
else
    info "All system packages already installed."
fi

# Docker (may be docker.io or docker-ce)
if ! command -v docker &>/dev/null; then
    info "Installing docker.io..."
    sudo apt install -y docker.io
    sudo usermod -aG docker "$USER"
    warn "Added $USER to docker group. You may need to log out/in for group to take effect."
fi

# Claude Code
if ! command -v claude &>/dev/null; then
    info "Installing Claude Code globally..."
    sudo npm install -g @anthropic-ai/claude-code
else
    info "Claude Code already installed: $(claude --version 2>/dev/null || echo 'unknown version')"
fi

# rclone remote check
if ! rclone listremotes 2>/dev/null | grep -q '^gdrive:$'; then
    warn "'gdrive' remote not configured."
    echo "  Run: rclone config"
    echo "  Set up a Google Drive remote named 'gdrive'"
    read -rp "Press Enter after configuring rclone, or Ctrl+C to abort... "
    rclone listremotes | grep -q '^gdrive:$' || fail "gdrive remote still not found."
fi

info "All prerequisites satisfied."

# ============================================================
phase "B — Pull from Google Drive"
# ============================================================

info "Syncing gdrive:Claude-Config/ -> ~/.claude/ ..."
rclone sync "gdrive:Claude-Config/" "$HOME/.claude/" -v 2>&1 | tail -5

info "Syncing gdrive:OpenDia/ -> ~/OpenDia/ (excluding venv)..."
rclone sync "gdrive:OpenDia/" "$HOME/OpenDia/" --exclude="venv/**" -v 2>&1 | tail -5

# Restore .claude.json to home root
if [ -f "$HOME/.claude/.claude.json" ]; then
    info "Restoring ~/.claude.json from sync..."
    cp "$HOME/.claude/.claude.json" "$HOME/.claude.json"
fi

info "Drive sync complete."

# ============================================================
phase "C — Build MCP Servers"
# ============================================================

MCP_DIR="$HOME/.claude/mcp-servers"
for server in toggl google-workspace square notion; do
    if [ -d "$MCP_DIR/$server" ]; then
        info "Building $server..."
        (cd "$MCP_DIR/$server" && npm install --silent && npm run build --silent)
        info "  $server built successfully."
    else
        warn "  $server directory not found at $MCP_DIR/$server — skipping."
    fi
done

# ============================================================
phase "D — Python Environment"
# ============================================================

cd "$HOME/OpenDia"

if [ ! -d venv ]; then
    info "Creating Python venv..."
    python3 -m venv venv
fi

info "Installing Python dependencies..."
source venv/bin/activate
if [ -f requirements.txt ]; then
    pip install -q -r requirements.txt
    info "  Installed $(wc -l < requirements.txt) packages."
else
    warn "  No requirements.txt found — skipping pip install."
fi
deactivate

# ============================================================
phase "E — Verify Database"
# ============================================================

cd "$HOME/OpenDia"

if [ -f opendia.db ]; then
    info "Database found. Testing queries..."
    source venv/bin/activate

    DIV_COUNT=$(python3 scripts/db_helper.py list-divisions 2>/dev/null | grep -c '|' || echo 0)
    if [ "$DIV_COUNT" -ge 5 ]; then
        check_pass "list-divisions returned $DIV_COUNT divisions"
    else
        check_fail "list-divisions returned $DIV_COUNT divisions (expected >= 5)"
    fi

    COMP_COUNT=$(python3 scripts/db_helper.py list-companies 2>/dev/null | grep -c '|' || echo 0)
    if [ "$COMP_COUNT" -ge 1 ]; then
        check_pass "list-companies returned $COMP_COUNT companies"
    else
        check_fail "list-companies returned $COMP_COUNT companies (expected >= 1)"
    fi

    deactivate
else
    check_fail "opendia.db not found — run init_db.py to create it"
fi

# ============================================================
phase "F — Docker MCP"
# ============================================================

if command -v docker &>/dev/null; then
    if sudo systemctl is-active --quiet docker 2>/dev/null; then
        info "Docker is running."
    else
        info "Starting Docker service..."
        sudo systemctl start docker
    fi
    info "Docker MCP config is in ~/.claude.json — containers will start on first use."
else
    warn "Docker not available. Notion + Context7 MCPs won't work until Docker is installed."
fi

# ============================================================
phase "G — Manual Auth Steps"
# ============================================================

echo ""
warn "The following require manual browser-based auth:"
echo ""
echo "  1. Google OAuth (for Google Workspace MCP):"
echo "     MCP_CREDENTIALS_PATH=~/.claude/mcp-credentials \\"
echo "       node ~/.claude/mcp-servers/google-workspace/dist/index.js"
echo "     Follow the URL, paste the auth code."
echo ""
echo "  2. Claude Code login:"
echo "     claude"
echo "     Follow the browser auth prompts."
echo ""

# ============================================================
phase "H — Verification Checklist"
# ============================================================

# Timer state files
TIMER_FILES=$(find "$HOME/OpenDia/Time/" -name "*.md" 2>/dev/null | wc -l)
if [ "$TIMER_FILES" -ge 1 ]; then
    check_pass "Time tracking files present ($TIMER_FILES .md files)"
else
    check_fail "No time tracking files found in ~/OpenDia/Time/"
fi

# Scripts present
if [ -f "$HOME/OpenDia/scripts/db_helper.py" ] && [ -f "$HOME/OpenDia/scripts/init_db.py" ]; then
    check_pass "OpenDia scripts present"
else
    check_fail "OpenDia scripts missing"
fi

# Claude configs
if [ -f "$HOME/.claude/CLAUDE.md" ] && [ -f "$HOME/.claude.json" ]; then
    check_pass "Claude configs present"
else
    check_fail "Claude configs missing"
fi

# MCP server builds
for server in toggl google-workspace square notion; do
    if [ -d "$HOME/.claude/mcp-servers/$server/dist" ] || [ -d "$HOME/.claude/mcp-servers/$server/node_modules" ]; then
        check_pass "MCP server '$server' built"
    else
        check_fail "MCP server '$server' not built"
    fi
done

echo ""
echo "================================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "================================================"
echo ""

if [ "$FAIL" -eq 0 ]; then
    info "All automated checks passed!"
else
    warn "$FAIL checks failed — review above."
fi

echo ""
info "Manual checks remaining (run inside Claude Code):"
echo "  - /checkin (Gmail MCP)"
echo "  - toggl_get_me (Toggl MCP)"
echo "  - square_list_locations (Square MCP)"
echo "  - Notion search (Docker MCP)"
echo "  - /start-timer + /stop-timer"
echo ""
info "Migration setup complete."
