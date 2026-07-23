#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

pid_file="$RUNTIME/pids/initial-sync.pid"
trap 'rm -f "$pid_file"' EXIT
cd "$APP"
ADDRESS_SYNC_MODE=initial ADDRESS_SYNC_TRIGGER=initial \
  "$NODE" "$APP/server/sync/address-etl.mjs" --initial --all
"$APP/ops/start.sh"
