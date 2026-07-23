PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS address_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  data_url TEXT NOT NULL,
  license_code TEXT NOT NULL,
  license_name TEXT NOT NULL,
  license_url TEXT NOT NULL,
  attribution_text TEXT NOT NULL,
  attribution_url TEXT NOT NULL,
  terms_url TEXT NOT NULL,
  share_alike INTEGER NOT NULL CHECK (share_alike IN (0, 1)),
  notice_required INTEGER NOT NULL CHECK (notice_required IN (0, 1)),
  redistribution_allowed INTEGER NOT NULL CHECK (redistribution_allowed IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS address_datasets (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES address_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  version TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  input_checksum TEXT NOT NULL CHECK (length(input_checksum) = 64),
  format TEXT NOT NULL,
  license_code TEXT NOT NULL,
  license_name TEXT NOT NULL,
  license_url TEXT NOT NULL,
  attribution_text TEXT NOT NULL,
  attribution_url TEXT NOT NULL,
  terms_url TEXT NOT NULL,
  share_alike INTEGER NOT NULL CHECK (share_alike IN (0, 1)),
  notice_required INTEGER NOT NULL CHECK (notice_required IN (0, 1)),
  redistribution_allowed INTEGER NOT NULL CHECK (redistribution_allowed IN (0, 1)),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'retired', 'failed')),
  UNIQUE (source_id, country_code, version, input_checksum)
);

CREATE TABLE IF NOT EXISTS address_pool (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  admin1 TEXT NOT NULL DEFAULT '',
  admin1_code TEXT NOT NULL DEFAULT '',
  locality TEXT NOT NULL DEFAULT '',
  postal_locality TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL CHECK (length(trim(street)) > 0),
  house_number TEXT NOT NULL CHECK (length(trim(house_number)) > 0),
  building_name TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  native_language TEXT NOT NULL,
  component_variants_json TEXT NOT NULL CHECK (json_valid(component_variants_json)),
  address_variants_json TEXT NOT NULL CHECK (json_valid(address_variants_json)),
  admin1_key TEXT NOT NULL DEFAULT '',
  admin1_code_key TEXT NOT NULL DEFAULT '',
  locality_key TEXT NOT NULL DEFAULT '',
  postal_locality_key TEXT NOT NULL DEFAULT '',
  district_key TEXT NOT NULL DEFAULT '',
  postcode_key TEXT NOT NULL DEFAULT '',
  property_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (property_type IN ('residential', 'apartment', 'commercial', 'mixed', 'unknown')),
  quality_score REAL NOT NULL CHECK (quality_score BETWEEN 0 AND 1),
  generation TEXT NOT NULL,
  coverage TEXT NOT NULL,
  random_key INTEGER NOT NULL CHECK (random_key BETWEEN 0 AND 2147483647),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT,
  retired_at TEXT,
  CHECK (active = 1 OR retired_at IS NOT NULL)
);

CREATE VIRTUAL TABLE IF NOT EXISTS address_coordinate_index USING rtree(
  address_rowid,
  min_latitude, max_latitude,
  min_longitude, max_longitude
);

CREATE TRIGGER IF NOT EXISTS address_coordinate_insert AFTER INSERT ON address_pool BEGIN
  INSERT INTO address_coordinate_index VALUES (new.rowid, new.latitude, new.latitude, new.longitude, new.longitude);
END;

CREATE TRIGGER IF NOT EXISTS address_coordinate_update AFTER UPDATE OF latitude, longitude ON address_pool BEGIN
  UPDATE address_coordinate_index
  SET min_latitude = new.latitude, max_latitude = new.latitude,
      min_longitude = new.longitude, max_longitude = new.longitude
  WHERE address_rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS address_coordinate_delete AFTER DELETE ON address_pool BEGIN
  DELETE FROM address_coordinate_index WHERE address_rowid = old.rowid;
END;

CREATE TABLE IF NOT EXISTS address_pool_evidence (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES address_pool(id) ON UPDATE CASCADE ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES address_datasets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL DEFAULT '',
  record_url TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  evidence_type TEXT NOT NULL DEFAULT 'address_existence'
    CHECK (evidence_type IN ('address_existence', 'residential_use', 'coordinate', 'building_status')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_coverage (
  coverage_key TEXT PRIMARY KEY,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  admin1_key TEXT NOT NULL DEFAULT '',
  locality_key TEXT NOT NULL DEFAULT '',
  postcode_key TEXT NOT NULL DEFAULT '',
  property_type TEXT NOT NULL DEFAULT 'unknown',
  target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  shadow_count INTEGER NOT NULL DEFAULT 0 CHECK (shadow_count >= 0),
  residential_count INTEGER NOT NULL DEFAULT 0 CHECK (residential_count >= 0),
  refresh_status TEXT NOT NULL DEFAULT 'low' CHECK (refresh_status IN ('ready', 'low', 'refreshing', 'failed')),
  generation TEXT NOT NULL,
  last_refreshed_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS catalog_regions (
  id INTEGER PRIMARY KEY,
  country_code TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  native_name TEXT NOT NULL,
  zh_name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES catalog_regions(id),
  path TEXT NOT NULL,
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS catalog_cities (
  id INTEGER PRIMARY KEY,
  country_code TEXT NOT NULL,
  region_id INTEGER REFERENCES catalog_regions(id),
  name TEXT NOT NULL,
  native_name TEXT NOT NULL,
  zh_name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'city',
  population INTEGER,
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS catalog_postcodes (
  id INTEGER PRIMARY KEY,
  country_code TEXT NOT NULL,
  region_id INTEGER REFERENCES catalog_regions(id),
  city_id INTEGER REFERENCES catalog_cities(id),
  code TEXT NOT NULL,
  locality_name TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS catalog_metadata (
  source TEXT PRIMARY KEY,
  source_version TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  region_count INTEGER NOT NULL,
  city_count INTEGER NOT NULL,
  postcode_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS residential_coverage (
  country_code TEXT NOT NULL,
  region_name TEXT NOT NULL DEFAULT '',
  city_name TEXT NOT NULL DEFAULT '',
  address_count INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT NOT NULL,
  region_id INTEGER,
  city_id INTEGER,
  PRIMARY KEY (country_code, region_name, city_name)
);

CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key TEXT NOT NULL,
  target_language TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (cache_key, target_language)
);

CREATE TABLE IF NOT EXISTS sync_country_state (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  last_success_at TEXT,
  next_sync_at TEXT,
  active_dataset_id TEXT REFERENCES address_datasets(id) ON UPDATE CASCADE ON DELETE SET NULL,
  address_count INTEGER NOT NULL DEFAULT 0 CHECK (address_count >= 0),
  residential_count INTEGER NOT NULL DEFAULT 0 CHECK (residential_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES sync_country_state(country_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  source_id TEXT REFERENCES address_sources(id) ON UPDATE CASCADE ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  mode TEXT NOT NULL CHECK (mode IN ('initial', 'scheduled', 'manual')),
  started_at TEXT,
  completed_at TEXT,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_bytes >= 0),
  database_bytes INTEGER NOT NULL DEFAULT 0 CHECK (database_bytes >= 0),
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_address_pool_country_random ON address_pool(country_code, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_property_random ON address_pool(country_code, property_type, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_residential_random ON address_pool(country_code, active, random_key, id)
  WHERE property_type IN ('residential','apartment');
CREATE INDEX IF NOT EXISTS idx_address_pool_admin1_random ON address_pool(country_code, admin1_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_locality_random ON address_pool(country_code, locality_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_postal_locality_random ON address_pool(country_code, postal_locality_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_district_random ON address_pool(country_code, district_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_postcode_random ON address_pool(country_code, postcode_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_generation ON address_pool(generation, active, expires_at);
CREATE INDEX IF NOT EXISTS idx_address_pool_coverage ON address_pool(coverage, active, property_type);
CREATE INDEX IF NOT EXISTS idx_address_pool_evidence_address ON address_pool_evidence(address_id, is_current, is_primary);
CREATE UNIQUE INDEX IF NOT EXISTS idx_address_pool_evidence_source_record
  ON address_pool_evidence(dataset_id, source_record_id, evidence_type) WHERE source_record_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_address_pool_primary_current
  ON address_pool_evidence(address_id) WHERE is_primary = 1 AND is_current = 1;
CREATE INDEX IF NOT EXISTS idx_pool_coverage_country ON pool_coverage(country_code, refresh_status, active_count);
CREATE INDEX IF NOT EXISTS idx_regions_country_name ON catalog_regions(country_code, name);
CREATE INDEX IF NOT EXISTS idx_regions_country_native ON catalog_regions(country_code, native_name);
CREATE INDEX IF NOT EXISTS idx_regions_parent ON catalog_regions(parent_id);
CREATE INDEX IF NOT EXISTS idx_cities_country_region_name ON catalog_cities(country_code, region_id, name);
CREATE INDEX IF NOT EXISTS idx_cities_country_population ON catalog_cities(country_code, population DESC);
CREATE INDEX IF NOT EXISTS idx_postcodes_country_region_city_code ON catalog_postcodes(country_code, region_id, city_id, code);
CREATE INDEX IF NOT EXISTS idx_postcodes_country_code ON catalog_postcodes(country_code, code);
CREATE INDEX IF NOT EXISTS idx_residential_country_region_city ON residential_coverage(country_code, region_name, city_name);
CREATE INDEX IF NOT EXISTS idx_residential_region_id ON residential_coverage(country_code, region_id);
CREATE INDEX IF NOT EXISTS idx_residential_city_id ON residential_coverage(country_code, city_id);
CREATE INDEX IF NOT EXISTS idx_sync_country_due ON sync_country_state(status, next_sync_at, country_code);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_country_created ON sync_jobs(country_code, created_at DESC);

CREATE VIEW IF NOT EXISTS address_pool_runtime AS
SELECT
  address_pool.*,
  address_pool_evidence.id AS evidence_id,
  address_pool_evidence.source_record_id,
  address_pool_evidence.record_url,
  address_pool_evidence.observed_at,
  address_pool_evidence.evidence_type,
  EXISTS (
    SELECT 1 FROM address_pool_evidence residential_evidence
    JOIN address_datasets residential_dataset ON residential_dataset.id = residential_evidence.dataset_id
      AND residential_dataset.status = 'active' AND residential_dataset.redistribution_allowed = 1
    JOIN address_sources residential_source ON residential_source.id = residential_dataset.source_id
      AND residential_source.redistribution_allowed = 1
    WHERE residential_evidence.address_id = address_pool.id
      AND residential_evidence.evidence_type = 'residential_use'
      AND residential_evidence.is_current = 1
  ) AS residential_evidence,
  address_datasets.id AS dataset_id,
  address_datasets.version AS dataset_version,
  address_datasets.published_at AS source_updated_at,
  address_datasets.imported_at,
  address_datasets.license_code AS source_license,
  address_datasets.license_url,
  address_sources.id AS source_id,
  address_sources.name AS source_name,
  address_sources.homepage_url AS source_url,
  address_sources.attribution_text,
  address_sources.attribution_url
FROM address_pool
JOIN address_pool_evidence ON address_pool_evidence.address_id = address_pool.id
  AND address_pool_evidence.is_primary = 1
  AND address_pool_evidence.is_current = 1
  AND address_pool_evidence.evidence_type = 'address_existence'
JOIN address_datasets ON address_datasets.id = address_pool_evidence.dataset_id
  AND address_datasets.status = 'active'
  AND address_datasets.redistribution_allowed = 1
JOIN address_sources ON address_sources.id = address_datasets.source_id
  AND address_sources.redistribution_allowed = 1;

INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
