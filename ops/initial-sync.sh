#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

pid_file="$RUNTIME/pids/initial-sync.pid"
supervisor_pid="$RUNTIME/pids/supervisor.pid"
if [ -f "$supervisor_pid" ] && kill -0 "$(cat "$supervisor_pid")" 2>/dev/null; then
  echo "Stop the service supervisor before the initial sync" >&2
  exit 1
fi
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "Initial sync is already running"
  exit 0
fi
cd "$APP"
nohup "$APP/ops/run-initial-sync.sh" >>"$ROOT/logs/initial-sync.log" 2>&1 &
echo $! >"$pid_file"
echo "Initial sync started pid=$(cat "$pid_file")"
