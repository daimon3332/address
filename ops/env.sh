#!/bin/sh
set -eu

ROOT=/root/address
APP="$ROOT/app"
RUNTIME="$ROOT/runtime"
NODE="$RUNTIME/node/bin/node"

export HOME="$RUNTIME/home"
export npm_config_cache="$RUNTIME/npm-cache"
export PIP_CACHE_DIR="$RUNTIME/pip-cache"
export ADDRESS_DATABASE_PATH="${ADDRESS_DATABASE_PATH:-$ROOT/data/address.sqlite}"
export ADDRESS_DATA_ROOT="${ADDRESS_DATA_ROOT:-$ROOT/data}"
export ADDRESS_SYNC_CACHE_DIR="${ADDRESS_SYNC_CACHE_DIR:-$ROOT/data/staging}"
export STATIC_ROOT="${STATIC_ROOT:-$APP/dist}"
export SYNC_STATE_DIR="${SYNC_STATE_DIR:-$RUNTIME/sync-control}"
export PYTHON_BIN="${PYTHON_BIN:-$RUNTIME/venv/bin/python}"

if [ -f "$RUNTIME/address.env" ]; then
  set -a
  . "$RUNTIME/address.env"
  set +a
fi

export HOME="$RUNTIME/home"
export npm_config_cache="$RUNTIME/npm-cache"
export PIP_CACHE_DIR="$RUNTIME/pip-cache"
for path in "$ADDRESS_DATABASE_PATH" "$ADDRESS_DATA_ROOT" "$ADDRESS_SYNC_CACHE_DIR" "$STATIC_ROOT" "$SYNC_STATE_DIR" "$PYTHON_BIN"; do
  case "$path" in
    "$ROOT"/*) ;;
    *) echo "Path outside $ROOT: $path" >&2; exit 1 ;;
  esac
done

mkdir -p "$ROOT/data/staging" "$ROOT/logs" "$ROOT/backups" "$RUNTIME/home" "$RUNTIME/pids"
test -x "$NODE"
test -d "$APP"
