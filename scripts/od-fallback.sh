#!/usr/bin/env bash
# od-fallback.sh — switch Claude Code between the Anthropic subscription and AWS Bedrock.
#
# WHY: on 2026-07-29 a ~3h Anthropic outage (529 Overloaded) took down claude.ai, the
# API, and Claude Code together. Bedrock serves the SAME Claude models from separate
# infrastructure with its own SLA, so failing over there keeps full model quality —
# and MCP servers, skills, and slash commands all keep working because those are
# client-side features of the CLI, not the model API.
#
# NOT a proxy, NOT an OAuth workaround: Claude Code supports Bedrock natively via
# CLAUDE_CODE_USE_BEDROCK. (Routing the Max-subscription OAuth token through a
# third-party proxy would violate Anthropic's consumer ToS — don't.)
#
# MUST BE SOURCED — it mutates the current shell's environment:
#   source ~/OpenDia/repo/scripts/od-fallback.sh {on|off|status|check}
# Or via the alias in ~/.bashrc:
#   od-fallback on
#
# Normal operation is the Anthropic subscription (free at the margin). Bedrock is
# pay-per-token, so only turn it on during an outage — and turn it off after.

# ── config (override in ~/OpenDia/.od-fallback.conf) ─────────────────────────────
OD_FALLBACK_REGION="${OD_FALLBACK_REGION:-us-east-1}"
OD_FALLBACK_MODEL="${OD_FALLBACK_MODEL:-}"        # e.g. us.anthropic.claude-...-v1:0
OD_FALLBACK_SMALL_MODEL="${OD_FALLBACK_SMALL_MODEL:-}"
[ -f "$HOME/OpenDia/.od-fallback.conf" ] && . "$HOME/OpenDia/.od-fallback.conf"

_odfb_sourced() { [ "${BASH_SOURCE[0]}" != "${0}" ]; }

_odfb_on() {
  if [ -z "$OD_FALLBACK_MODEL" ]; then
    echo "  !! OD_FALLBACK_MODEL is not set — run 'od-fallback check' first to discover"
    echo "     the real Bedrock model IDs, then write them to ~/OpenDia/.od-fallback.conf"
    echo "     Continuing anyway; Claude Code will try its own Bedrock default."
  fi
  export CLAUDE_CODE_USE_BEDROCK=1
  export AWS_REGION="$OD_FALLBACK_REGION"
  [ -n "$OD_FALLBACK_MODEL" ]       && export ANTHROPIC_MODEL="$OD_FALLBACK_MODEL"
  [ -n "$OD_FALLBACK_SMALL_MODEL" ] && export ANTHROPIC_SMALL_FAST_MODEL="$OD_FALLBACK_SMALL_MODEL"
  cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
  │  FALLBACK MODE ON — Claude via AWS Bedrock (PAY-PER-TOKEN)   │
  └──────────────────────────────────────────────────────────────┘
    region : $AWS_REGION
    model  : ${ANTHROPIC_MODEL:-<Claude Code default>}
    small  : ${ANTHROPIC_SMALL_FAST_MODEL:-<Claude Code default>}

    Next:  claude --resume <session>      (MCP + slash commands work as normal)
    After the outage:  od-fallback off

EOF
}

_odfb_off() {
  unset CLAUDE_CODE_USE_BEDROCK ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL AWS_REGION
  echo "  Fallback OFF — back on the Anthropic subscription (OAuth) for new sessions."
}

_odfb_status() {
  if [ -n "$CLAUDE_CODE_USE_BEDROCK" ]; then
    echo "  BACKEND: AWS Bedrock (fallback mode, pay-per-token)"
    echo "    region=${AWS_REGION:-unset} model=${ANTHROPIC_MODEL:-default} small=${ANTHROPIC_SMALL_FAST_MODEL:-default}"
    echo "    NOTE: only affects sessions started from THIS shell."
  else
    echo "  BACKEND: Anthropic subscription (OAuth) — normal operation."
  fi
  [ -f "$HOME/OpenDia/.od-fallback.conf" ] \
    && echo "  config: ~/OpenDia/.od-fallback.conf" \
    || echo "  config: none yet (run 'od-fallback check')"
}

# Preflight — the whole point is to fail HERE, in calm conditions, not mid-outage.
_odfb_check() {
  local region="$OD_FALLBACK_REGION" fail=0
  echo "  Bedrock preflight (region $region)"
  echo "  ------------------------------------------------------------"

  if ! command -v aws >/dev/null 2>&1; then
    echo "  FAIL  aws CLI not installed"; return 1
  fi
  local who
  if who=$(aws sts get-caller-identity --query Arn --output text 2>&1); then
    echo "  ok    AWS identity: $who"
  else
    echo "  FAIL  AWS credentials not working: $who"; return 1
  fi

  local models
  if models=$(aws bedrock list-foundation-models --region "$region" \
        --query "modelSummaries[?providerName=='Anthropic'].modelId" --output text 2>&1); then
    if [ -z "$models" ]; then
      echo "  FAIL  no Anthropic models visible — enable model access in the Bedrock console"
      fail=1
    else
      echo "  ok    Anthropic models visible in Bedrock:"
      echo "$models" | tr '\t' '\n' | sed 's/^/          /' | tail -15
    fi
  else
    echo "  FAIL  cannot list models:"
    echo "$models" | sed 's/^/          /' | head -3
    echo "        → attach bedrock:ListFoundationModels + bedrock:InvokeModel to this IAM user"
    fail=1
  fi

  if [ -n "$OD_FALLBACK_MODEL" ]; then
    echo "  ok    configured model: $OD_FALLBACK_MODEL"
    # A real invoke is the only thing that proves the path end-to-end.
    local body out
    body='{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[{"role":"user","content":"say ok"}]}'
    if out=$(aws bedrock-runtime invoke-model --region "$region" \
              --model-id "$OD_FALLBACK_MODEL" --body "$(printf '%s' "$body" | base64 -w0)" \
              /dev/stdout 2>&1 >/dev/null); then
      echo "  ok    live invoke succeeded — fallback is READY"
    else
      echo "  FAIL  live invoke failed:"; echo "$out" | sed 's/^/          /' | head -3
      fail=1
    fi
  else
    echo "  ..    no OD_FALLBACK_MODEL set yet. Pick a main + small model from the list"
    echo "        above and write ~/OpenDia/.od-fallback.conf:"
    echo "          OD_FALLBACK_REGION=$region"
    echo "          OD_FALLBACK_MODEL=us.anthropic.<main-model-id>"
    echo "          OD_FALLBACK_SMALL_MODEL=us.anthropic.<haiku-model-id>"
    fail=1
  fi

  echo "  ------------------------------------------------------------"
  [ "$fail" -eq 0 ] && echo "  PASS — fallback verified." || echo "  NOT READY — fix the FAIL lines above."
  return $fail
}

case "${1:-status}" in
  on)     _odfb_sourced || { echo "must be sourced: source ${BASH_SOURCE[0]} on"; exit 1; }; _odfb_on ;;
  off)    _odfb_sourced || { echo "must be sourced: source ${BASH_SOURCE[0]} off"; exit 1; }; _odfb_off ;;
  status) _odfb_status ;;
  check)  _odfb_check ;;
  *)      echo "usage: od-fallback {on|off|status|check}" ;;
esac
