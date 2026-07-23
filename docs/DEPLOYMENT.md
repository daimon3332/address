# Address Deployment Guide

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

This guide covers private configuration, initial data synchronization, VPS deployment, reverse proxying, upgrades, and backups. Production scripts target Linux AMD64 and ARM64 and keep all runtime state under `/root/address`.

## Requirements

- Linux VPS with AMD64 or ARM64 CPU
- At least 4 GB RAM; 8 GB is recommended for the full initial import
- At least 60 GiB available on the application volume
- `git`, `curl`, `ca-certificates`, `xz-utils`, Python 3, and `venv`
- A domain pointing to the VPS and an HTTPS-capable reverse proxy

The installer downloads the project-pinned Node.js runtime. A system-wide Node.js installation is not required.

## Storage estimate

Measured on 2026-07-23 after all 27 countries were synchronized at commit `084805e`:

| Item | Measured size |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| Active SQLite WAL | 0.68 GiB |
| Complete `data/` directory | 7.89 GiB |
| Active addresses | 722,950 records |
| China community records | 174,327 records |

The initial import temporarily retains source downloads and intermediate files. The observed peak was about 11.2 GiB. Upstream releases, WAL activity, and optional retention settings change the actual total. The 60 GiB recommendation leaves room for synchronization, backups, and recovery. Shadow expansion stops at 40 GiB, writes stop before 45 GiB, and the project keeps a 50 GiB absolute ceiling.

## API keys and secrets

The offline address pool, Overture and Geofabrik synchronization, SQLite generation, OpenCC conversion, pinyin conversion, Google Maps links, and AMap web links require no third-party API key.

| Variable | Required | Feature | Where to obtain it |
|---|---|---|---|
| `AMAP_API_KEY` | Optional | Live China POI lookup | Create a Web Service key in the [AMap console](https://lbs.amap.com/api/webservice/guide/create-project/get-key). |
| `GEOAPIFY_API_KEY` | Optional | Live geocoding outside China and selected reverse localization | Create a project and key using the [Geoapify guide](https://www.geoapify.com/get-started-with-maps-api/). |
| `YOUDAO_APP_KEY`, `YOUDAO_APP_SECRET` | Optional pair | Backup online translation provider | Create a translation application at [Youdao AI](https://ai.youdao.com/). |
| `ONEMAP_ACCESS_TOKEN` | Optional | Live ordinary-address lookup for Singapore | Follow the [OneMap authentication guide](https://www.onemap.gov.sg/apidocs/authentication). Tokens expire and need refresh handling. |
| `SYNC_ADMIN_TOKEN` | Required on a VPS | Protect sync-control mutations | Generate locally; this is not a third-party credential. |

Keep `LIVE_API_MODES=ip-region` to restrict live providers to IP-nearby generation. Regular generation then uses the local database. Set `GOOGLE_TRANSLATION_ENABLED=false` unless online translation is explicitly needed.

## Secret handling

The repository templates contain placeholders only:

| Template | Purpose |
|---|---|
| `.env.example` | Local UI and API development |
| `server/sync/.env.example` | Synchronization parameter reference |
| `ops/address.env.example` | Combined VPS runtime configuration |
| `ops/deploy.env.example` | Private SSH deployment settings |

`.env`, `.deploy.env`, databases, logs, runtime state, caches, private keys, and `plan.md` are ignored by Git. Store real values only in ignored private files. Do not place secrets in browser variables, source code, screenshots, issues, command output, or CI logs.

On the VPS, use a mode-`600` runtime file:

```bash
mkdir -p /root/address/runtime
cp /root/address/app/ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
```

Generate the sync token without printing it:

```bash
token="$(openssl rand -hex 32)"
sed -i "s/GENERATE_A_RANDOM_VALUE/$token/" /root/address/runtime/address.env
unset token
chmod 600 /root/address/runtime/address.env
```

At minimum, replace `YOUR_DOMAIN.example`, generate `SYNC_ADMIN_TOKEN`, and review `TRUST_PROXY`. Add optional provider credentials only when their feature is enabled.

## Runtime configuration

| Variable | Production default | Purpose |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `/api` | API prefix used by the browser |
| `API_HOST` | `127.0.0.1` | Hono listen address |
| `API_PORT` | `8787` | Hono listen port |
| `STATIC_ROOT` | `/root/address/app/dist` | Built Astro site |
| `ADDRESS_DATABASE_PATH` | `/root/address/data/address.sqlite` | SQLite database |
| `ALLOWED_ORIGIN` | Your HTTPS origin | CORS allowlist |
| `TRUST_PROXY` | `true` behind the proxy | Trust forwarded client IP headers |
| `SYNC_HOST` | `127.0.0.1` | Sync-control listen address |
| `SYNC_PORT` | `8791` | Sync-control port |
| `SYNC_CONTROL_PUBLIC` | `false` | Keep sync management off the public API |
| `SYNC_UTC_HOUR` | `3` | Daily scheduler check hour in UTC |

Only enable `TRUST_PROXY` when a controlled reverse proxy overwrites forwarded IP headers. Keep port `8791` private.

## First deployment

### 1. Prepare the VPS

```bash
apt-get update
apt-get install -y git curl ca-certificates xz-utils python3 python3-venv nginx
mkdir -p /root/address
git clone https://github.com/daimon3332/address.git /root/address/app
cd /root/address/app
./ops/install-runtime.sh
```

`install-runtime.sh` installs the pinned Node.js runtime, Python virtual environment, Python dependencies, and npm dependencies under `/root/address`.

### 2. Configure private runtime values

```bash
mkdir -p /root/address/runtime
cp ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
editor /root/address/runtime/address.env
```

Set `ALLOWED_ORIGIN=https://YOUR_DOMAIN.example`, create `SYNC_ADMIN_TOKEN`, and add only the optional provider credentials you need.

### 3. Build the WebUI

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
npm run build
```

### 4. Initialize all countries

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

The job runs in the background. Each country is validated and published independently, and completed cache entries are reusable after a restart. Runtime depends on VPS CPU, storage, network, and upstream availability. The API and scheduler start after a successful initial run.

### 5. Verify the services

```bash
/root/address/app/ops/status.sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/data-health
```

## Nginx and HTTPS

Use your existing TLS workflow and proxy the public domain to the API process:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN.example;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Expose only HTTP/HTTPS in the firewall. Keep the API and sync-control listeners on loopback. After TLS is active, use the exact HTTPS origin for `ALLOWED_ORIGIN`.

## Synchronization and operations

- The initial job processes all 27 countries and resumes completed work.
- The steady-state scheduler checks at 03:00 UTC and updates at most one due country per day.
- Each successful country snapshot becomes due again after 30 days.
- Failed snapshots never replace the current active data.
- Raw source files are removed after publication unless retention is explicitly enabled.

```bash
# Service lifecycle
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# Consistent SQLite backup
/root/address/app/ops/backup.sh

# Restore a backup stored under /root/address/backups
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.sqlite
```

The project supervisor is process-based and does not install systemd or cron entries. Connect `ops/start.sh` to the VPS's existing boot mechanism when automatic restart after a host reboot is required.

## Deploy subsequent commits

On the development machine:

```bash
cp ops/deploy.env.example .deploy.env
chmod 600 .deploy.env
editor .deploy.env
bash ops/deploy.sh --dist
```

The deployment script archives the current `HEAD`, uploads it through SSH, preserves the VPS database, private runtime file, and server blacklist, restarts the supervisor, and performs a health check. Use `--no-restart` for documentation-only changes.

## Production checklist

- DNS and HTTPS are active.
- `ALLOWED_ORIGIN` is the exact public HTTPS origin.
- `TRUST_PROXY=true` is used only behind the controlled proxy.
- `SYNC_ADMIN_TOKEN` is random, private, and absent from Git history.
- `SYNC_CONTROL_PUBLIC=false` and port `8791` is not public.
- Optional provider keys have provider-side restrictions and usage alerts.
- `npm run check:production` passes after the database is initialized.
- A current backup exists and restore has been tested.
- At least 60 GiB is allocated and free-space monitoring is enabled.
