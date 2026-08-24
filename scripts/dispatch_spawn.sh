#!/usr/bin/env bash
# dispatch_spawn.sh SESSION_NAME BRIEF_PATH [WORK_DIR] [--yolo] [--model MODEL]
#
# Spawns a named tmux session running interactive claude, pre-fed the handoff
# brief. Collision-suffixes the session name (-2, -3, ... per od-new
# convention). Echoes the final session name on stdout so the caller can
# PATCH the dashboard card.
#
# Model policy (2026-08-11): a dispatched session starts in plan mode on
# opusplan by default, so it reads its brief and plans on Opus, then drops to
# Sonnet the moment the plan is accepted. This is structural on purpose — the
# separation should not depend on either operator remembering to enter plan
# mode. That default is the /dispatch operator-handoff path, where the session
# is picking up a genuinely new task.
# --yolo REPLACES the permission mode (never appends: two --permission-mode
# flags are undefined) and is the escape hatch for known-mechanical work.
# --model MODEL overrides the model for this spawn only. Runrooms pass
# `opus[1m]` (2026-08-23): their plan is already vetted in the planroom, so they
# run it rather than re-plan it — plain opus keeps judgment on hand when the
# operator types new information back into the box, and dropping plan mode (via
# --yolo) is what keeps entry calm. `opusplan` without plan mode would collapse
# to Sonnet, so the model flag and --yolo travel together for runrooms.
set -eu

MODEL="opusplan[1m]"
MODE="plan"

SESSION="${1:?usage: dispatch_spawn.sh SESSION_NAME BRIEF_PATH [WORK_DIR] [--yolo] [--model MODEL]}"
BRIEF="${2:?missing BRIEF_PATH}"
shift 2

WORKDIR="$HOME/OpenDia"
while [ $# -gt 0 ]; do
    case "$1" in
        --yolo)  MODE="acceptEdits" ;;
        --model) shift; MODEL="${1:?--model needs a value}" ;;
        *)       WORKDIR="$1" ;;
    esac
    shift
done

[ -f "$BRIEF" ] || { echo "brief not found: $BRIEF" >&2; exit 1; }

FINAL="$SESSION"
n=2
while tmux has-session -t "$FINAL" 2>/dev/null; do
    FINAL="${SESSION}-${n}"
    n=$((n + 1))
done

# Constant, short initial prompt — all variable content lives in the brief file.
PROMPT="Read $BRIEF and follow it, starting with the On start command."
# $MODEL is single-quoted in the command string: tmux hands this to sh, and an
# unquoted opusplan[1m] would be read as a glob.
tmux new-session -d -s "$FINAL" -c "$WORKDIR" "claude -n $FINAL --model '$MODEL' --permission-mode $MODE \"$PROMPT\""

echo "$FINAL"
