#!/bin/sh
set -eu

ROOT=/root/address
RUNTIME="$ROOT/runtime"
NODE_VERSION=v24.14.1
case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) echo "Unsupported server architecture: $(uname -m)" >&2; exit 1 ;;
esac
ARCHIVE="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
URL="https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE"

cd "$ROOT"
mkdir -p "$RUNTIME/downloads" "$RUNTIME/home" "$RUNTIME/npm-cache" "$RUNTIME/pip-cache"
if [ ! -x "$RUNTIME/node/bin/node" ] || ! "$RUNTIME/node/bin/node" --version >/dev/null 2>&1; then
  curl -fL "$URL" -o "$RUNTIME/downloads/$ARCHIVE"
  curl -fL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$RUNTIME/downloads/SHASUMS256.txt"
  (cd "$RUNTIME/downloads" && grep " $ARCHIVE\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$RUNTIME/node" "$RUNTIME/node-$NODE_VERSION-linux-$NODE_ARCH"
  tar -xJf "$RUNTIME/downloads/$ARCHIVE" -C "$RUNTIME"
  mv "$RUNTIME/node-$NODE_VERSION-linux-$NODE_ARCH" "$RUNTIME/node"
fi
if [ ! -x "$RUNTIME/venv/bin/python" ]; then
  python3 -m venv "$RUNTIME/venv"
fi
HOME="$RUNTIME/home" PIP_CACHE_DIR="$RUNTIME/pip-cache" "$RUNTIME/venv/bin/pip" install -r "$ROOT/app/server/sync/requirements.txt"
HOME="$RUNTIME/home" npm_config_cache="$RUNTIME/npm-cache" \
  "$RUNTIME/node/bin/node" "$RUNTIME/node/lib/node_modules/npm/bin/npm-cli.js" --prefix "$ROOT/app" ci
