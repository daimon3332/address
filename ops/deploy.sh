#!/usr/bin/env bash
# One-command deploy from the local repo to the server.
# Usage:
#   cp ops/deploy.env.example .deploy.env  # configure private SSH values first
#   ops/deploy.sh            # deploy server code + docs, restart services
#   ops/deploy.sh --dist     # also rebuild and deploy the frontend (dist/)
#   ops/deploy.sh --no-restart  # sync files only (docs-only changes)
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY_ENV=${ADDRESS_DEPLOY_ENV:-$REPO_ROOT/.deploy.env}
if [[ -f "$DEPLOY_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  set +a
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST or create .deploy.env from ops/deploy.env.example}"
DEPLOY_PORT=${DEPLOY_PORT:-22}
DEPLOY_USER=${DEPLOY_USER:-root}
: "${DEPLOY_KEY:?Set DEPLOY_KEY to the SSH private-key path}"
ADDRESS_ROOT=${ADDRESS_ROOT:-/root/address}

case "$DEPLOY_PORT" in
  ''|*[!0-9]*) echo "DEPLOY_PORT must be numeric" >&2; exit 1 ;;
esac
if (( DEPLOY_PORT < 1 || DEPLOY_PORT > 65535 )); then
  echo "DEPLOY_PORT must be between 1 and 65535" >&2
  exit 1
fi
if [[ ! "$DEPLOY_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || [[ ! "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "DEPLOY_HOST or DEPLOY_USER contains unsupported characters" >&2
  exit 1
fi
if [[ ! "$ADDRESS_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "ADDRESS_ROOT must be a safe absolute path" >&2
  exit 1
fi

KEY=${DEPLOY_KEY/#\~/$HOME}
if [[ ! -f "$KEY" ]]; then
  echo "DEPLOY_KEY does not point to a file" >&2
  exit 1
fi
REMOTE=$DEPLOY_USER@$DEPLOY_HOST
APP=$ADDRESS_ROOT/app
RUNTIME=$ADDRESS_ROOT/runtime

cd "$REPO_ROOT"
REL=$(git rev-parse --short HEAD)
TARBALL=/tmp/address-$REL.tar.gz
WITH_DIST=false
RESTART=true
for arg in "$@"; do
  case "$arg" in
    --dist) WITH_DIST=true ;;
    --no-restart) RESTART=false ;;
  esac
done

echo "==> packaging $REL"
git archive --format=tar.gz -o "$TARBALL" HEAD

if $WITH_DIST; then
  echo "==> building frontend"
  npm run build
  tar -czf /tmp/dist-$REL.tar.gz dist
fi

scp_retry() {
  for i in 1 2 3 4 5; do
    scp -i "$KEY" -P "$DEPLOY_PORT" -o BatchMode=yes -o ConnectTimeout=15 "$@" && return 0
    echo "scp retry $i"; sleep 30
  done
  return 1
}
ssh_retry() {
  for i in 1 2 3 4 5; do
    ssh -i "$KEY" -p "$DEPLOY_PORT" -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE" "$@" && return 0
    echo "ssh retry $i"; sleep 30
  done
  return 1
}

echo "==> uploading"
scp_retry "$TARBALL" "$REMOTE:$RUNTIME/"
$WITH_DIST && scp_retry /tmp/dist-$REL.tar.gz "$REMOTE:$RUNTIME/"

echo "==> extracting (server blacklist and dist are preserved unless --dist)"
ssh_retry "cd $APP && tar --exclude=dist --exclude=config/blacklist.txt -xzf $RUNTIME/address-$REL.tar.gz && echo $REL > RELEASE"
if $WITH_DIST; then
  ssh_retry "cd $APP && rm -rf dist && tar -xzf $RUNTIME/dist-$REL.tar.gz"
fi

if $RESTART; then
  echo "==> restarting"
  ssh_retry "$APP/ops/stop.sh && sleep 3 && $APP/ops/start.sh"
  sleep 15
  echo "==> health check"
  ssh_retry "$APP/ops/status.sh"
else
  echo "==> files synced, no restart"
fi
echo "==> deployed $REL"
