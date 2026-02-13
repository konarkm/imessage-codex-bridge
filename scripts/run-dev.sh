#!/usr/bin/env bash
set -euo pipefail

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

RESTART_EXIT_CODE=42

while true; do
  set +e
  npm run dev
  exit_code=$?
  set -e

  if [ "$exit_code" -eq "$RESTART_EXIT_CODE" ]; then
    echo "bridge requested restart (exit $RESTART_EXIT_CODE), relaunching in 1s..."
    sleep 1
    continue
  fi

  exit "$exit_code"
done
