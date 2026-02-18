#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOCK_DIR="$REPO_ROOT/.bridge-run.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"

release_run_lock() {
  local lock_pid
  lock_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  if [ "$lock_pid" = "$$" ]; then
    rm -rf "$LOCK_DIR" || true
  fi
}

acquire_run_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    trap release_run_lock EXIT
    return
  fi

  if [ ! -f "$LOCK_PID_FILE" ]; then
    echo "bridge appears to already be running (lock dir exists: $LOCK_DIR)"
    echo "if no bridge is running, remove the lock dir and retry"
    exit 1
  fi

  local existing_pid
  existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "bridge is already running (pid $existing_pid)"
    echo "stop the existing process before starting another"
    exit 1
  fi

  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    trap release_run_lock EXIT
    return
  fi

  echo "failed to acquire bridge run lock: $LOCK_DIR"
  exit 1
}

acquire_run_lock

load_env() {
  if [ -f .env ]; then
    set -a
    source .env
    set +a
  fi
}

load_env

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
  load_env

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
