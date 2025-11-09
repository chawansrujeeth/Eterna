#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[start-api] $*"
}

stop_process() {
  local pid="${1:-}"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  log "cleaning up background processes..."
  stop_process "${API_PID:-}"
  stop_process "${WORKER_PID:-}"
  if [[ -n "${API_PID:-}" ]]; then
    wait "${API_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WORKER_PID:-}" ]]; then
    wait "${WORKER_PID}" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

log "running prisma migrate deploy..."
npx prisma migrate deploy

log "starting Worker..."
node dist/worker/index.js &
WORKER_PID=$!

log "starting API..."
node dist/api/index.js &
API_PID=$!

wait -n "$API_PID" "$WORKER_PID"
EXIT_CODE=$?

cleanup
exit "$EXIT_CODE"
