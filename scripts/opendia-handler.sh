#!/usr/bin/env bash
# Protocol handler for opendia:// URIs
# Parses opendia://tmux/SESSION_NAME and opens a terminal with SSH+tmux
#
# Install: copy opendia-handler.desktop to ~/.local/share/applications/
#          then run: xdg-mime default opendia-handler.desktop x-scheme-handler/opendia

URI="$1"

# Strip the scheme
PATH_PART="${URI#opendia://}"

# Parse action and argument
ACTION="${PATH_PART%%/*}"
ARG="${PATH_PART#*/}"

# Configuration — edit these for your environment
OPENDIA_USER="${OPENDIA_USER:-linnflux}"
OPENDIA_HOST="${OPENDIA_HOST:-opendia}"

case "$ACTION" in
  tmux)
    if [ -z "$ARG" ] || [ "$ARG" = "$ACTION" ]; then
      echo "Usage: opendia://tmux/SESSION_NAME"
      exit 1
    fi
    CMD="ssh ${OPENDIA_USER}@${OPENDIA_HOST} -t 'tmux attach -t ${ARG} || tmux new-session -s ${ARG}'"
    # Try common terminal emulators in order of preference
    if command -v gnome-terminal &>/dev/null; then
      gnome-terminal -- bash -c "$CMD; exec bash"
    elif command -v xfce4-terminal &>/dev/null; then
      xfce4-terminal -e "bash -c \"$CMD; exec bash\""
    elif command -v konsole &>/dev/null; then
      konsole -e bash -c "$CMD; exec bash"
    elif command -v xterm &>/dev/null; then
      xterm -e bash -c "$CMD; exec bash"
    else
      # Fallback: try x-terminal-emulator (Debian/Ubuntu default)
      x-terminal-emulator -e bash -c "$CMD; exec bash"
    fi
    ;;
  *)
    echo "Unknown action: $ACTION"
    echo "Supported: opendia://tmux/SESSION_NAME"
    exit 1
    ;;
esac
