#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$ROOT/backups/address-$timestamp.sqlite"
test -f "$ADDRESS_DATABASE_PATH"
"$NODE" -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.exec(\"VACUUM INTO '\"+process.argv[2].replaceAll(\"'\",\"''\")+\"'\");db.close()" "$ADDRESS_DATABASE_PATH" "$target"
echo "$target"
