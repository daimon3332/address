# Deployment

English · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

Address supports a single production deployment method: **Docker Compose**. The app, PostgreSQL, migrations, and automatic synchronization are all managed by the `docker-compose.yml` in the repository root.

## Requirements

| Item | Requirement |
|---|---|
| OS | Linux, AMD64 or ARM64 |
| Runtime | Docker Engine 24+, Docker Compose v2 |
| Memory | 4 GB minimum; 8 GB or more for the first import of large countries such as the US or France |
| Disk | About 15 GB of database for all 27 countries, plus room for sync staging and backups |
| Network | Access to Docker Hub and the data sources; an HTTPS reverse proxy for public access |

## Install

```bash
mkdir address && cd address
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/daimon3332/address/main/docker-compose.yml
docker compose up -d
```

Check the result:

```bash
docker compose ps                                  # every service should be running / healthy
curl -fsS http://127.0.0.1:8787/api/v1/ready       # {"status":"ready"} means it is ready
```

Open `http://127.0.0.1:8787/admin/`, sign in with the initial password `admin`, and change it when prompted.

## Services

| Service | Role | Lifecycle |
|---|---|---|
| `bootstrap` | Generates and validates internal secrets | Exits when done |
| `postgres` | PostgreSQL 16, internal network only | Long-running |
| `migrate` | Applies database migrations before each start | Exits when done |
| `api` | Web UI and API on `127.0.0.1:8787` | Long-running |
| `sync` | Automatic synchronization | Long-running |
| `credential-broker` | Provider-key encryption, rotation, and quota coordination | Long-running |

`sync` loads the administrative catalog on start and can take a few minutes to become healthy. The web UI and API are available in the meantime.

## Layout

Everything lives next to the Compose file, so moving or backing up an installation means copying that directory.

```text
address/
├── docker-compose.yml
├── .env                 # optional overrides
├── data/
│   ├── secrets/         # generated internal secrets (back these up)
│   ├── postgres/        # database files
│   └── address/         # sync staging
├── runtime/             # sync runtime state
└── backups/             # suggested backup location
```

Never let two PostgreSQL containers mount the same `data/postgres`.

## Configuration

The defaults work as-is. To change them, create a `.env` next to the Compose file:

| Variable | Default | Description |
|---|---|---|
| `ADDRESS_IMAGE` | `daimon23/address:latest` | Application image; pin a version tag if you prefer |
| `API_BIND_ADDRESS` | `127.0.0.1` | API listen address; `0.0.0.0` exposes it directly (not recommended) |
| `API_PORT` | `8787` | API port |
| `ALLOWED_ORIGINS` | empty | Comma-separated origins allowed for cross-origin requests |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy to see real client IPs |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS |
| `ADMIN_INITIAL_PASSWORD` | `admin` | Administrator password used on first start only |
| `FRONTEND_INITIAL_PASSWORD` | empty | Public generator password on first start; empty disables it |
| `TRANSLATION_BACKFILL_ENABLED` | `true` | Fill in multilingual translations for published addresses in the background |

Run `docker compose up -d` to apply changes. Passwords, API tokens, provider keys, and sync targets are managed in the admin console, not in `.env`.

## Reverse proxy

Expose only ports 80/443, forward them to `127.0.0.1:8787`, and set in `.env`:

```dotenv
ALLOWED_ORIGINS=https://address.example.com
TRUST_PROXY=true
COOKIE_SECURE=true
```

**Caddy** (automatic certificates):

```caddyfile
address.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

**Nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name address.example.com;

    ssl_certificate     /etc/ssl/address.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/address.example.com/privkey.pem;

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

Never expose PostgreSQL or the sync service.

## Operations

```bash
docker compose ps                     # status
docker compose logs -f api sync       # logs
docker compose restart api            # restart one service
docker compose down                   # stop (data is kept)
docker compose up -d                  # start
```

## Upgrade

```bash
# 1. Back up first (next section)
# 2. Pull the new image and recreate
docker compose pull
docker compose up -d
docker compose ps
```

Migrations run automatically in the `migrate` service. Blue/green production activation runs it with `--skip-coverage`; the sync service then rebuilds the generation index and coverage statistics in the background after it starts. Activation runs detached on the server and logs to `runtime/deploy/activation-<release>.log` (exit status in `.exit`), so a dropped SSH session cannot interrupt a cutover. Migration reindexes and revalidates Hong Kong only when the administrative catalog overrides changed its rows. After a successful activation, images of releases outside the retained set that no container uses, and build cache older than 24 hours, are removed. To pin a version, set `ADDRESS_IMAGE` in `.env` to a specific tag.

## Backup and restore

Back up:

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"
cp -r data/secrets backups/secrets-$(date -u +%Y%m%d)
```

Restore:

```bash
docker compose stop api sync credential-broker
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < backups/address-YYYYMMDDTHHMMSSZ.dump
docker compose up -d
```

> **Keep `data/secrets/config_master_key` with every database backup.** Provider keys stored in the admin console are encrypted with it; without it they must be re-entered.

Across PostgreSQL major versions, use `pg_dump` / `pg_restore`; never reuse `data/postgres` directly.

## FAQ

**I forgot the administrator password.**
Regenerate the initial password and remove the current administrator; the service recreates the administrator from the new initial password on start (at least 10 characters):

```bash
docker compose stop api
rm data/secrets/admin_bootstrap_password
ADMIN_INITIAL_PASSWORD='your-new-password' docker compose run --rm bootstrap
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
DELETE FROM control.auth_identities WHERE kind = 'admin';
DELETE FROM control.auth_sessions WHERE role = 'admin';
SQL
docker compose up -d
```

**A first start fails with `service "migrate" didn't complete successfully: exit 1`.**
Releases up to v2.4.0 could not import the location catalog into an empty database (`Use database.transaction() for PostgreSQL transactions`, or later `Location catalog bootstrap incomplete: postcodes`). Upgrade to v2.4.1 or later, then start again; the catalog import resumes on its own:

```bash
docker compose pull
docker compose up -d
```

**`sync` stays in `starting`.**
`sync` loads the administrative catalog and verifies published data on start; larger databases take longer, sometimes several minutes. Follow `docker compose logs -f sync`; steady log output means it is working. The web UI and API are unaffected.

**A country stays “Below target”.**
Open the country under **Address Data** in the admin console. The **Overview** tab shows the current state and its reason, such as waiting for a quota reset, a missing provider key, or an exhausted source. Most countries sync without any key; see [API keys](API_KEYS.md) for the ones that need one.

**Can I run it without Docker?**
Docker Compose is the only maintained production method. For local development, see the [development guide](DEVELOPMENT.md).

## Image publishing

Pushing a version tag (`v*`) builds AMD64/ARM64 images with GitHub Actions and publishes them to Docker Hub as `daimon23/address` (the version, `major.minor`, and `latest`); pushes to `main` only run verification. The repository needs a `DOCKERHUB_TOKEN` secret (a Docker Hub access token with read/write scope).
