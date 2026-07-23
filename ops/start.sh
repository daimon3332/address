#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

pid_file="$RUNTIME/pids/supervisor.pid"
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  exit 0
fi
cd "$APP"
nohup "$NODE" "$APP/ops/supervisor.mjs" >>"$ROOT/logs/supervisor.log" 2>&1 &
echo $! >"$pid_file"
