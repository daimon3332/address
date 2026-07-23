# Address Development Guide

[English](DEVELOPMENT.md) · [简体中文](DEVELOPMENT.zh-CN.md) · [繁體中文](DEVELOPMENT.zh-TW.md)

## Architecture

```text
Browser
  -> Astro static pages + React WebUI
  -> Hono Node.js API
       -> SQLite WAL address pool
       -> SQLite RTree coordinate index
       -> local formatting and localization
       -> optional live providers
  -> synchronization supervisor
       -> DuckDB reads Overture GeoParquet
       -> pyosmium reads Geofabrik/OSM PBF
       -> validation and atomic country snapshot publication
```

Ordinary generation reads the local SQLite pool. Live providers are opt-in and constrained by `LIVE_API_MODES` or a request's `live=true` flag.

## Repository layout

| Path | Responsibility |
|---|---|
| `src/components/` | React WebUI and synchronization administration UI |
| `src/domain/` | Country metadata, generation, formatting, localization, profile, and export rules |
| `src/pages/` | Astro routes for localized WebUI and API documentation |
| `server/api/` | Hono application, repositories, and external-provider adapters |
| `server/database/` | SQLite schema and migration entry point |
| `server/sync/` | Source adapters, ETL, scheduler, snapshot publication, and sync-control API |
| `scripts/` | Catalog generation, validation, live probes, and release audits |
| `ops/` | Linux VPS installation, process, backup, restore, and deployment scripts |
| `tests/` | Vitest unit, integration, data-quality, and UI-structure tests |

## Local setup

Node.js 24 or newer is required. Python 3 and `venv` are required only for source synchronization.

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

The Astro development server proxies `/api` to Hono on `127.0.0.1:8787` and `/sync-control` to the local synchronization service on `127.0.0.1:8791`. A freshly migrated database has schema only and does not contain an address pool.

Useful commands:

| Command | Purpose |
|---|---|
| `npm run dev` | Run Astro and Hono in watch mode |
| `npm run dev:web` | Run only Astro |
| `npm run dev:api` | Run only Hono |
| `npm run db:migrate` | Create or migrate the local SQLite schema |
| `npm run data:regions` | Refresh bundled region metadata |
| `npm run data:catalog` | Synchronize the location catalog |
| `npm run data:address-pool:estimate` | Estimate a synchronization plan |
| `npm run data:address-pool:sync:dry-run` | Validate ETL planning without publication |
| `npm run data:address-pool:bootstrap` | Run the resumable all-country initial import |
| `npm run sync:serve` | Run the local scheduler and sync-control API |

## Configuration model

Copy `.env.example` to the ignored `.env` file. Keep secrets server-side. Only variables explicitly prefixed for Astro's public environment are eligible for browser bundling; third-party provider keys and `SYNC_ADMIN_TOKEN` must remain in the API/sync process environment.

Regular development needs no third-party API key. Optional live integrations are documented in the [deployment guide](DEPLOYMENT.md).

## Database and synchronization

SQLite runs in WAL mode and stores address records, localization, source evidence, country state, and RTree coordinates. Country publication is transactional: a candidate snapshot is validated before it replaces the active country dataset, and a failed candidate leaves the previous snapshot available.

Synchronization sources:

- Overture Maps: DuckDB remotely filters and reads GeoParquet.
- OpenStreetMap via Geofabrik: pyosmium streams prefiltered PBF nodes and ways.
- Local region and location catalogs: constrain selectors and validate administrative consistency.

The pipeline filters institutional/non-address features, deduplicates records, checks residential evidence, validates localized components, and enforces storage budgets. Do not edit `data/address.sqlite` manually while the API or synchronization job is active.

Manual examples:

```bash
node server/sync/address-etl.mjs --initial --all
node server/sync/address-etl.mjs --daily --all
node server/sync/address-etl.mjs --manual --shard US
```

## Extending the public API

1. Define request validation and the route in `server/api/index.ts`.
2. Keep database access behind `server/api/repositories/`.
3. Put provider/network logic in `server/api/services/` with explicit timeouts.
4. Return the existing `{ data: ... }` or `{ error: { code, message } }` envelope.
5. Add API tests and update all three API documents.

Public errors should use stable machine-readable codes. Do not make callers branch on localized UI strings.

## Extending countries or address rules

Country behavior spans metadata, formatting, location options, localization, postal rules, source shard planning, and test expectations. Before adding a country:

1. Define its metadata and supported filters in `src/domain/`.
2. Add formatting and postcode behavior.
3. Add a source shard and verify licensing/attribution metadata.
4. Validate ordinary and residential evidence separately.
5. Add localization, determinism, fallback, and postal-format tests.
6. Regenerate catalogs only through the existing scripts.

Generated indoor fields and synthetic profile data must remain explicitly distinguishable from source-backed address components.

## WebUI development

Localized pages enter through `src/pages/[locale].astro` and mount `src/components/App.tsx`. Shared presentation rules live in `src/styles/global.css`; the synchronization surface uses `SyncAdmin.tsx` and `admin.css`.

When changing result fields, update the domain type first, then generation, API serialization, UI rendering, exports, translations, and tests as one contract. Preserve stable result-section dimensions and verify both English and Chinese values.

## Validation and release gate

Run before every commit:

```bash
npm test
npm run check
npm run build
npm run check:public
```

These commands cover Vitest, Astro diagnostics, TypeScript, production bundling, ignored-file policy, required public files, and common secret shapes. On Linux, CI also validates shell syntax and compiles Python files.

After a full database is synchronized, run:

```bash
npm run check:production
```

This checks database integrity, required tables, country readiness, and storage ceilings. Live-environment probes are separate commands because they require a running deployment.

## Contribution checklist

- Keep changes scoped and avoid unrelated dependency or formatting churn.
- Add tests proportional to the behavioral change.
- Update English, Simplified Chinese, and Traditional Chinese documentation together.
- Keep real credentials, databases, logs, screenshots with private data, and runtime state out of Git.
- Run `git diff --check` in addition to the project commands.
- Preserve source attribution and licenses when changing the data pipeline.
