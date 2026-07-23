#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

for name in supervisor initial-sync; do
  pid_file="$RUNTIME/pids/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    printf '%s running pid=%s\n' "$name" "$(cat "$pid_file")"
  else
    printf '%s stopped\n' "$name"
  fi
done
curl -fsS "http://127.0.0.1:${API_PORT:-8787}/api/v1/health" || true
