#!/usr/bin/env bash
set -euo pipefail

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

CODEX_BIN_CMD="${CODEX_BIN:-codex}"
MIN_CODEX_VERSION="0.101.0"

if ! codex_version_output="$("$CODEX_BIN_CMD" --version 2>&1)"; then
  echo "failed to run CODEX_BIN ('$CODEX_BIN_CMD') --version"
  echo "set CODEX_BIN in .env to a working Codex CLI binary (>= $MIN_CODEX_VERSION)"
  exit 1
fi

if [[ "$codex_version_output" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  codex_major="${BASH_REMATCH[1]}"
  codex_minor="${BASH_REMATCH[2]}"
  if (( codex_major == 0 && codex_minor < 101 )); then
    echo "Codex CLI version is too old: $codex_version_output"
    echo "please upgrade Codex CLI to >= $MIN_CODEX_VERSION"
    exit 1
  fi
else
  echo "warning: could not parse Codex version from: $codex_version_output"
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
