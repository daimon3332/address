#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

job_id="${1:-}"
case "$job_id" in
  sync-[a-zA-Z0-9-]*) ;;
  *) echo "Invalid sync job ID" >&2; exit 1 ;;
esac

job_file="$SYNC_STATE_DIR/jobs/$job_id.json"
while grep -Eq '"status": "(queued|running)"' "$job_file"; do
  sleep 20
done

curl -fsS -X POST \
  -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"mode":"initial","shards":["all"]}' \
  "http://${SYNC_HOST:-127.0.0.1}:${SYNC_PORT:-8791}/api/v1/sync/jobs"
