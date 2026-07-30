#!/usr/bin/env bash
# migrate-setup.sh — Bootstrap OpenDia on a new LMDE7 machine
# Pulls everything from Google Drive (populated by migrate-export.sh)
# Run as your regular user ($USER), NOT as root.

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

# Docker (optional — only needed if you plan to use Docker-based MCP servers)
if ! command -v docker &>/dev/null; then
    info "Docker not installed. Skipping (install later with 'sudo apt install docker.io' if needed)."
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

# Clone dashboard repo (excluded from Drive sync; git is the source of truth)
if [ ! -d "$HOME/OpenDia/repo/.git" ]; then
    info "Cloning OpenDia dashboard repo..."
    git clone git@github.com:linnflux/OpenDia.git "$HOME/OpenDia/repo"
else
    info "OpenDia repo already present — pulling latest..."
    git -C "$HOME/OpenDia/repo" pull
fi

# Install systemd user unit for the dashboard
UNIT_SRC="$HOME/OpenDia/repo/systemd/opendia-dashboard.service"
UNIT_DEST="$HOME/.config/systemd/user/opendia-dashboard.service"
if [ -f "$UNIT_SRC" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cp "$UNIT_SRC" "$UNIT_DEST"
    systemctl --user daemon-reload
    systemctl --user enable --now opendia-dashboard.service
    info "Dashboard service installed and started."
else
    warn "systemd unit not found at $UNIT_SRC — start dashboard manually."
fi

# Restore the other user units that migrate-export.sh snapshots (cloudflared
# tunnel, etc.). Export backed these up; restore used to ignore them, so the
# calendar webhook had to be rebuilt by hand after a migration.
UNITS_SNAPSHOT="$HOME/OpenDia/systemd-units"
if [ -d "$UNITS_SNAPSHOT" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    for unit in "$UNITS_SNAPSHOT"/*.service; do
        [ -f "$unit" ] || continue
        name=$(basename "$unit")
        [ "$name" = "opendia-dashboard.service" ] && continue  # handled above, from git
        cp -n "$unit" "$HOME/.config/systemd/user/$name"
        systemctl --user enable "$name" 2>/dev/null \
            && info "Restored + enabled $name" \
            || warn "Could not enable $name — check its EnvironmentFile/secrets."
    done
    systemctl --user daemon-reload
else
    warn "No systemd-units snapshot at $UNITS_SNAPSHOT — restore units manually."
fi

# Restore cron jobs (calendar sync, inbox/intake ticks, backup, reaper, whistle).
# Without this, every scheduled job silently does not exist after a migration.
CRON_BACKUP="$HOME/OpenDia/crontab.backup"
if [ -f "$CRON_BACKUP" ]; then
    if [ -n "$(crontab -l 2>/dev/null)" ]; then
        warn "A crontab already exists — NOT overwriting."
        warn "Review and merge manually: $CRON_BACKUP"
    else
        crontab "$CRON_BACKUP"
        info "Cron jobs restored from $CRON_BACKUP ($(wc -l < "$CRON_BACKUP") lines)."
    fi
else
    warn "No crontab backup at $CRON_BACKUP — scheduled jobs will NOT run."
fi

# User services must survive a reboot with no login session.
loginctl enable-linger "$USER" 2>/dev/null && info "Linger enabled for $USER." \
    || warn "Could not enable linger — services will not start until you log in."

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
phase "F — Docker MCP Support (Optional)"
# ============================================================

if command -v docker &>/dev/null; then
    if sudo systemctl is-active --quiet docker 2>/dev/null; then
        info "Docker is running."
    else
        info "Starting Docker service..."
        sudo systemctl start docker
    fi
    info "Docker is available for any MCP servers that require containers."
else
    info "Docker not installed. Install later with 'sudo apt install docker.io' if you need Docker-based MCP servers."
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
echo "  3. GitLab access (SSH key + Personal Access Token):"
echo "     SSH key and PAT are intentionally NOT backed up to Drive."
echo "     On a fresh machine:"
echo "       a) Generate a new ed25519 key:"
echo "          ssh-keygen -t ed25519 -f ~/.ssh/gitlab_opendia -N ''"
echo "          Add the .pub to gitlab.com -> Edit profile -> SSH Keys."
echo "       b) Add this to ~/.ssh/config:"
echo "          Host gitlab.com"
echo "              HostName gitlab.com"
echo "              User git"
echo "              IdentityFile ~/.ssh/gitlab_opendia"
echo "              IdentitiesOnly yes"
echo "       c) Create a new PAT on gitlab.com -> Edit profile -> Access Tokens"
echo "          (scopes: api, read_repository, write_repository, read_user, read_registry)"
echo "          mkdir -p ~/.claude/mcp-credentials/gitlab"
echo "          printf '%s' 'YOUR_TOKEN' > ~/.claude/mcp-credentials/gitlab/token"
echo "          chmod 600 ~/.claude/mcp-credentials/gitlab/token"
echo "       d) Install glab CLI (apt version is too old):"
echo "          See reference_gitlab.md in the memory dir for details."
echo ""
echo "  4. Gemini API key (for nano_banana.py image generation):"
echo "     API key is intentionally NOT backed up to Drive."
echo "     a) Create a key at https://aistudio.google.com/apikey"
echo "     b) mkdir -p ~/.claude/mcp-credentials/gemini"
echo "        printf '%s' 'YOUR_KEY' > ~/.claude/mcp-credentials/gemini/api_key"
echo "        chmod 600 ~/.claude/mcp-credentials/gemini/api_key"
echo "     c) Enable billing on the linked GCP project (image gen is paid-tier only)."
echo "     See reference_gemini.md in the memory dir for details."
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

# Deployment config — resource IDs are not in the repo, so a fresh machine that
# restored without them looks fine until the first billing or calendar run
# crashes. Check at setup time instead of discovering it from a cron failure.
if [ -f "$HOME/OpenDia/.opendia.conf" ]; then
    MISSING_IDS=""
    for key in BILLING_OPS_SHEET_ID NOTION_TASKS_DB_ID TOGGL_WORKSPACE_ID; do
        grep -qE "^${key}=.+" "$HOME/OpenDia/.opendia.conf" || MISSING_IDS="$MISSING_IDS $key"
    done
    if [ -z "$MISSING_IDS" ]; then
        check_pass "Deployment config present (~/OpenDia/.opendia.conf)"
    else
        check_fail "~/OpenDia/.opendia.conf missing values:$MISSING_IDS"
    fi
else
    check_fail "~/OpenDia/.opendia.conf missing — copy repo/examples/opendia.conf.example and fill it in"
fi

# Outage fallback config (optional — only used during an AI provider outage)
if [ -f "$HOME/OpenDia/.od-fallback.conf" ]; then
    check_pass "Outage fallback configured (run 'od-fallback check' to verify live)"
else
    warn "~/OpenDia/.od-fallback.conf absent — no AI outage fallback on this machine."
    echo "       See repo/examples/od-fallback.conf.example and docs/outage-fallback.md"
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
echo "  - Notion search (Notion MCP)"
echo "  - /start-timer + /stop-timer"
echo ""
info "Migration setup complete."
