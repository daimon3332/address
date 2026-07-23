#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

source_file=${1:-}
case "$source_file" in
  "$ROOT"/backups/*.sqlite) ;;
  *) echo "Backup must be under $ROOT/backups" >&2; exit 1 ;;
esac
test -f "$source_file"
"$APP/ops/stop.sh"
cp "$source_file" "$ADDRESS_DATABASE_PATH.restore"
rm -f "$ADDRESS_DATABASE_PATH-wal" "$ADDRESS_DATABASE_PATH-shm"
mv "$ADDRESS_DATABASE_PATH.restore" "$ADDRESS_DATABASE_PATH"
"$APP/ops/start.sh"
