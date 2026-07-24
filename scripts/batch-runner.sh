#!/usr/bin/env bash
# batch-runner.sh — Resilient cc-orch wrapper with automatic retry on infra errors.
#
# Runs cc-orch in a loop, handling exit code 75 (infra/transient error) with
# exponential backoff cooldowns (2h → 4h → 8h, capped). All other non-zero
# exit codes are treated as fatal and propagated immediately.
#
# Usage:
#   ./scripts/batch-runner.sh <spec-file>   # Start a fresh run
#   ./scripts/batch-runner.sh --resume      # Resume a previously saved run
#
# Examples:
#   ./scripts/batch-runner.sh specs/my-project.md
#   ./scripts/batch-runner.sh --resume

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
RESUME=false
SPEC=""

for arg in "$@"; do
  case "$arg" in
    --resume)
      RESUME=true
      ;;
    *)
      SPEC="$arg"
      ;;
  esac
done

if [[ "$RESUME" == false && -z "$SPEC" ]]; then
  echo "Usage: $0 <spec-file>"
  echo "       $0 --resume"
  exit 1
fi

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
COOLDOWN_INIT=7200   # 2h in seconds
COOLDOWN_MAX=28800   # 8h in seconds
cooldown=$COOLDOWN_INIT
attempt=0

while true; do
  attempt=$(( attempt + 1 ))
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] Attempt $attempt — starting cc-orch..."

  # Build command
  if [[ "$RESUME" == true ]]; then
    cmd="cc-orch resume"
  else
    cmd="cc-orch run $SPEC"
  fi

  # Run cc-orch and capture exit code (set -e is disabled for this command)
  exit_code=0
  $cmd || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    cooldown=$COOLDOWN_INIT  # reset cooldown on non-75 exit
    echo "[$timestamp] cc-orch completed successfully on attempt $attempt."
    exit 0
  elif [[ $exit_code -eq 75 ]]; then
    ts_now=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts_now] Infra error (exit 75) on attempt $attempt. Cooling down for ${cooldown}s before retry..."
    sleep "$cooldown"

    # Double cooldown for next potential 75, capped at max
    next_cooldown=$(( cooldown * 2 ))
    if [[ $next_cooldown -gt $COOLDOWN_MAX ]]; then
      cooldown=$COOLDOWN_MAX
    else
      cooldown=$next_cooldown
    fi

    # After a 75, always resume (state was saved)
    RESUME=true
  else
    cooldown=$COOLDOWN_INIT  # reset cooldown on non-75 exit
    ts_now=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts_now] ALERT: cc-orch exited with code $exit_code on attempt $attempt. Aborting."
    exit "$exit_code"
  fi
done
