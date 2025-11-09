#!/bin/sh
set -eu

API_PID=""
WORKER_PID=""
EXIT_CODE=0

log() {
  printf '[start-api] %s\n' "$*"
}

stop_process() {
  pid="${1:-}"
  if [ -n "$pid" ]; then
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || :
    fi
  fi
}

wait_for() {
  pid="${1:-}"
  if [ -n "$pid" ]; then
    wait "$pid" 2>/dev/null || :
  fi
}

cleanup() {
  log "cleaning up background processes..."
  stop_process "${API_PID:-}"
  stop_process "${WORKER_PID:-}"
  wait_for "${API_PID:-}"
  wait_for "${WORKER_PID:-}"
}
trap cleanup INT TERM

set_exit_code() {
  pid="$1"
  if wait "$pid"; then
    EXIT_CODE=0
  else
    EXIT_CODE=$?
  fi
}

monitor_processes() {
  while :; do
    if [ -n "${API_PID:-}" ]; then
      if ! kill -0 "$API_PID" 2>/dev/null; then
        set_exit_code "$API_PID"
        API_PID=""
        log "API exited (code ${EXIT_CODE}). stopping worker..."
        stop_process "${WORKER_PID:-}"
        return "$EXIT_CODE"
      fi
    fi

    if [ -n "${WORKER_PID:-}" ]; then
      if ! kill -0 "$WORKER_PID" 2>/dev/null; then
        set_exit_code "$WORKER_PID"
        WORKER_PID=""
        log "Worker exited (code ${EXIT_CODE}). stopping API..."
        stop_process "${API_PID:-}"
        return "$EXIT_CODE"
      fi
    fi

    sleep 1
  done
}

log "running prisma migrate deploy..."
npx prisma migrate deploy

log "starting Worker..."
node dist/worker/index.js &
WORKER_PID=$!

log "starting API..."
node dist/api/index.js &
API_PID=$!

if monitor_processes; then
  FINAL_CODE=$EXIT_CODE
else
  FINAL_CODE=$EXIT_CODE
fi

cleanup
exit "$FINAL_CODE"
