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
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (metadata_json IS JSON),
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
  source_complete INTEGER NOT NULL DEFAULT 1 CHECK (source_complete IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'retired', 'failed')),
  UNIQUE (source_id, country_code, version, input_checksum)
);

CREATE TABLE IF NOT EXISTS address_pool (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  admin1 TEXT NOT NULL DEFAULT '',
  admin1_code TEXT NOT NULL DEFAULT '',
  locality TEXT NOT NULL DEFAULT '',
  postal_locality TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL CHECK (length(trim(street)) > 0),
  house_number TEXT NOT NULL DEFAULT '',
  building_name TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  native_language TEXT NOT NULL,
  component_variants_json TEXT NOT NULL CHECK (component_variants_json IS JSON),
  address_variants_json TEXT NOT NULL CHECK (address_variants_json IS JSON),
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

ALTER TABLE address_pool ADD COLUMN IF NOT EXISTS canonical_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_address_pool_canonical_key
  ON address_pool(country_code,canonical_key) WHERE canonical_key <> '';

CREATE TABLE IF NOT EXISTS address_generation_index (
  address_id TEXT PRIMARY KEY REFERENCES address_pool(id) ON UPDATE CASCADE ON DELETE CASCADE,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  admin1_key TEXT NOT NULL DEFAULT '',
  admin1_code_key TEXT NOT NULL DEFAULT '',
  locality_key TEXT NOT NULL DEFAULT '',
  postal_locality_key TEXT NOT NULL DEFAULT '',
  district_key TEXT NOT NULL DEFAULT '',
  postcode_key TEXT NOT NULL DEFAULT '',
  locality TEXT NOT NULL DEFAULT '',
  postal_locality TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL DEFAULT '',
  house_number TEXT NOT NULL DEFAULT '',
  building_name TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  random_key INTEGER NOT NULL CHECK (random_key BETWEEN 0 AND 2147483647),
  country_rank BIGINT,
  residential_rank BIGINT,
  residential_ready INTEGER NOT NULL DEFAULT 0 CHECK (residential_ready IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  source_revision TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

ALTER TABLE address_pool ADD COLUMN IF NOT EXISTS match_level TEXT NOT NULL DEFAULT 'premise'
  CHECK (match_level IN ('street','premise','subpremise'));
ALTER TABLE address_pool DROP CONSTRAINT IF EXISTS address_pool_house_number_check;
UPDATE address_pool SET match_level='subpremise'
WHERE match_level='premise' AND trim(component_variants_json::jsonb -> 'native' ->> 'unit') <> '';

CREATE TABLE IF NOT EXISTS address_pool_revisions (
  kind TEXT PRIMARY KEY,
  version TEXT NOT NULL
);

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

-- Catalog native names replaced by the reviewed correction table; the sync service rewrites stored addresses that
-- were filled with the old name and then marks the row applied.
CREATE TABLE IF NOT EXISTS catalog_native_repairs (
  table_name TEXT NOT NULL,
  catalog_id BIGINT NOT NULL,
  country_code TEXT NOT NULL,
  region_id BIGINT,
  old_native TEXT NOT NULL,
  new_native TEXT NOT NULL,
  english_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (table_name, catalog_id, old_native)
);

CREATE TABLE IF NOT EXISTS residential_coverage (
  country_code TEXT NOT NULL,
  region_name TEXT NOT NULL DEFAULT '',
  city_name TEXT NOT NULL DEFAULT '',
  address_count INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT NOT NULL,
  region_id INTEGER,
  city_id INTEGER,
  identity_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (country_code, region_name, city_name, identity_key)
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
  source_version TEXT,
  failure_code TEXT,
  failure_signature TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE residential_coverage ADD COLUMN IF NOT EXISTS total_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE residential_coverage ADD COLUMN IF NOT EXISTS identity_key TEXT NOT NULL DEFAULT '';
ALTER TABLE residential_coverage DROP CONSTRAINT IF EXISTS residential_coverage_pkey;
ALTER TABLE residential_coverage ADD CONSTRAINT residential_coverage_pkey PRIMARY KEY (country_code,region_name,city_name,identity_key);
UPDATE residential_coverage SET total_count=address_count WHERE total_count<address_count;

CREATE TABLE IF NOT EXISTS sync_country_runtime (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  goal_state TEXT NOT NULL CHECK (goal_state IN ('complete', 'incomplete', 'disabled')),
  execution_state TEXT NOT NULL CHECK (execution_state IN (
    'ready', 'below_target', 'running', 'cooldown_wait', 'quota_wait', 'source_limited', 'blocked', 'failed'
  )),
  next_attempt_at TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_worker_leases (
  worker_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_shard_state (
  shard_id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  last_success_at TEXT,
  next_sync_at TEXT,
  active_dataset_id TEXT REFERENCES address_datasets(id) ON UPDATE CASCADE ON DELETE SET NULL,
  address_count INTEGER NOT NULL DEFAULT 0 CHECK (address_count >= 0),
  residential_count INTEGER NOT NULL DEFAULT 0 CHECK (residential_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error TEXT,
  source_version TEXT,
  failure_code TEXT,
  failure_signature TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_source_execution_state (
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  source_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('checked','exhausted','backoff','suspended')),
  reason TEXT,
  source_fingerprint TEXT,
  failure_fingerprint TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failure_code TEXT,
  adapter TEXT,
  failure_phase TEXT,
  failure_signature TEXT,
  checkpoint_token TEXT,
  wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('quota','credential','network')),
  probe_failures INTEGER NOT NULL DEFAULT 0 CHECK (probe_failures >= 0),
  probe_version TEXT,
  next_attempt_at TEXT,
  exhausted_at TEXT,
  last_attempt_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (country_code, source_id)
);

ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS checkpoint_token TEXT;
ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS probe_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS probe_version TEXT;

CREATE TABLE IF NOT EXISTS cn_admin_areas (
  adcode TEXT PRIMARY KEY,
  parent_adcode TEXT REFERENCES cn_admin_areas(adcode),
  level TEXT NOT NULL CHECK (level IN ('province','city','district','township')),
  name TEXT NOT NULL,
  full_path TEXT NOT NULL,
  longitude REAL,
  latitude REAL,
  source_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cn_communities_v2 (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  district TEXT NOT NULL,
  township TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  provider_address TEXT NOT NULL DEFAULT '',
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  verification_level TEXT NOT NULL DEFAULT 'L1' CHECK (verification_level IN ('L1','L2','L3')),
  source_count INTEGER NOT NULL DEFAULT 1 CHECK (source_count >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cn_community_sources (
  provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent')),
  provider_poi_id TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES cn_communities_v2(id) ON DELETE CASCADE,
  raw_name TEXT NOT NULL,
  raw_address TEXT NOT NULL DEFAULT '',
  raw_longitude REAL NOT NULL,
  raw_latitude REAL NOT NULL,
  raw_crs TEXT NOT NULL CHECK (raw_crs IN ('GCJ-02','BD-09')),
  response_hash TEXT NOT NULL,
  accepted_strategy_version TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_poi_id)
);

CREATE TABLE IF NOT EXISTS cn_ingest_candidates (
  provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent')),
  provider_poi_id TEXT NOT NULL,
  target_adcode TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  province TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  township TEXT NOT NULL DEFAULT '',
  longitude REAL NOT NULL,
  latitude REAL NOT NULL,
  raw_longitude REAL NOT NULL,
  raw_latitude REAL NOT NULL,
  raw_crs TEXT NOT NULL CHECK (raw_crs IN ('GCJ-02','BD-09')),
  typecode TEXT NOT NULL DEFAULT '',
  adcode TEXT NOT NULL DEFAULT '',
  response_hash TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accepted','rejected')),
  rejection_reason TEXT NOT NULL DEFAULT '',
  strategy_version TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_poi_id)
);

CREATE TABLE IF NOT EXISTS cn_sync_targets (
  city TEXT PRIMARY KEY,
  province TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  target_count INTEGER NOT NULL DEFAULT 500 CHECK (target_count >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cn_sync_checkpoints (
  provider TEXT NOT NULL,
  city TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  accepted_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  page_signature TEXT,
  updated_at TEXT NOT NULL,
  strategy_version TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (provider, city)
);

CREATE TABLE IF NOT EXISTS cn_sync_area_targets (
  adcode TEXT PRIMARY KEY,
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  district TEXT NOT NULL,
  query TEXT NOT NULL,
  target_count INTEGER NOT NULL DEFAULT 5 CHECK (target_count >= 1),
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_coverage_stats (
  node_key TEXT PRIMARY KEY,
  parent_key TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4),
  region_code TEXT NOT NULL DEFAULT '',
  region_name TEXT NOT NULL,
  ordinary_count INTEGER NOT NULL DEFAULT 0 CHECK (ordinary_count >= 0),
  residential_count INTEGER NOT NULL DEFAULT 0 CHECK (residential_count >= 0),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  child_count INTEGER NOT NULL DEFAULT 0 CHECK (child_count >= 0),
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

CREATE TABLE IF NOT EXISTS sync_country_policies (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  target_count INTEGER NOT NULL CHECK (target_count >= 1),
  level1_limit INTEGER NOT NULL CHECK (level1_limit >= 0),
  level2_limit INTEGER NOT NULL CHECK (level2_limit >= 0),
  level3_limit INTEGER NOT NULL CHECK (level3_limit >= 0),
  level4_limit INTEGER NOT NULL CHECK (level4_limit >= 0),
  min_per_node INTEGER NOT NULL DEFAULT 5 CHECK (min_per_node BETWEEN 1 AND 100),
  coverage_ratio REAL NOT NULL DEFAULT 1.0 CHECK (coverage_ratio BETWEEN 0 AND 1),
  level1_min INTEGER NOT NULL DEFAULT 0 CHECK (level1_min BETWEEN 0 AND 50000),
  level2_min INTEGER NOT NULL DEFAULT 0 CHECK (level2_min BETWEEN 0 AND 50000),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_node_overrides (
  node_key TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES sync_country_policies(country_code) ON UPDATE CASCADE ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
  target_count INTEGER CHECK (target_count IS NULL OR target_count >= 0),
  min_count INTEGER CHECK (min_count IS NULL OR min_count BETWEEN 0 AND 50000),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  prepare_concurrency INTEGER NOT NULL DEFAULT 10 CHECK (prepare_concurrency BETWEEN 1 AND 10),
  cpu_concurrency INTEGER NOT NULL DEFAULT 4 CHECK (cpu_concurrency BETWEEN 1 AND 4),
  updated_at TEXT NOT NULL
);

ALTER TABLE cn_sync_checkpoints ADD COLUMN IF NOT EXISTS page_signature TEXT;

CREATE TABLE IF NOT EXISTS publication_validation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT '',
  last_id TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_address_pool_country_random ON address_pool(country_code, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_active_country_id ON address_pool(country_code, id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_address_pool_property_random ON address_pool(country_code, property_type, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_residential_random ON address_pool(country_code, active, random_key, id)
  WHERE property_type IN ('residential','apartment');
CREATE INDEX IF NOT EXISTS idx_address_pool_zh_han_id ON address_pool(country_code, id)
  WHERE active=1 AND (
    (component_variants_json::jsonb -> 'zh-CN' ->> 'street') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'locality') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'postalLocality') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'district') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'dependentLocality') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'admin1') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'buildingName') ~ '[一-龥]'
  );
CREATE INDEX IF NOT EXISTS idx_address_pool_zh_han_random ON address_pool(country_code, random_key, id)
  WHERE active=1 AND (
    (component_variants_json::jsonb -> 'zh-CN' ->> 'street') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'locality') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'postalLocality') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'district') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'dependentLocality') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'admin1') ~ '[一-龥]'
    OR (component_variants_json::jsonb -> 'zh-CN' ->> 'buildingName') ~ '[一-龥]'
  );
CREATE INDEX IF NOT EXISTS idx_address_pool_admin1_random ON address_pool(country_code, admin1_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_locality_random ON address_pool(country_code, locality_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_postal_locality_random ON address_pool(country_code, postal_locality_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_district_random ON address_pool(country_code, district_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_postcode_random ON address_pool(country_code, postcode_key, active, random_key, id);
CREATE INDEX IF NOT EXISTS idx_address_pool_generation ON address_pool(generation, active, expires_at);
CREATE INDEX IF NOT EXISTS idx_address_pool_coverage ON address_pool(coverage, active, property_type);
CREATE INDEX IF NOT EXISTS idx_address_pool_evidence_address ON address_pool_evidence(address_id, is_current, is_primary);
CREATE INDEX IF NOT EXISTS idx_address_pool_evidence_dataset ON address_pool_evidence(dataset_id, evidence_type);
CREATE INDEX IF NOT EXISTS idx_address_pool_evidence_current_dataset
  ON address_pool_evidence(address_id, dataset_id) WHERE is_current = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_address_pool_primary_current
  ON address_pool_evidence(address_id) WHERE is_primary = 1 AND is_current = 1;
CREATE INDEX IF NOT EXISTS idx_pool_coverage_country ON pool_coverage(country_code, refresh_status, active_count);
CREATE INDEX IF NOT EXISTS idx_regions_country_name ON catalog_regions(country_code, name);
CREATE INDEX IF NOT EXISTS idx_regions_country_native ON catalog_regions(country_code, native_name);
CREATE INDEX IF NOT EXISTS idx_regions_country_code_lower ON catalog_regions(country_code, lower(code));
CREATE INDEX IF NOT EXISTS idx_regions_country_name_lower ON catalog_regions(country_code, lower(name));
CREATE INDEX IF NOT EXISTS idx_regions_country_native_lower ON catalog_regions(country_code, lower(native_name));
CREATE INDEX IF NOT EXISTS idx_regions_parent ON catalog_regions(parent_id);
CREATE INDEX IF NOT EXISTS idx_cities_country_region_name ON catalog_cities(country_code, region_id, name);
CREATE INDEX IF NOT EXISTS idx_cities_country_population ON catalog_cities(country_code, population DESC);
CREATE INDEX IF NOT EXISTS idx_cities_country_name_lower ON catalog_cities(country_code, lower(name), population DESC);
CREATE INDEX IF NOT EXISTS idx_cities_country_native_lower ON catalog_cities(country_code, lower(native_name), population DESC);
CREATE INDEX IF NOT EXISTS idx_postcodes_country_region_city_code ON catalog_postcodes(country_code, region_id, city_id, code);
CREATE INDEX IF NOT EXISTS idx_postcodes_country_code ON catalog_postcodes(country_code, code);
CREATE INDEX IF NOT EXISTS idx_residential_country_region_city ON residential_coverage(country_code, region_name, city_name);
CREATE INDEX IF NOT EXISTS idx_residential_region_id ON residential_coverage(country_code, region_id);
CREATE INDEX IF NOT EXISTS idx_residential_city_id ON residential_coverage(country_code, city_id);
CREATE INDEX IF NOT EXISTS idx_sync_country_due ON sync_country_state(status, next_sync_at, country_code);
ALTER TABLE address_datasets ADD COLUMN IF NOT EXISTS source_complete INTEGER NOT NULL DEFAULT 1
  CHECK (source_complete IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_sync_shard_due ON sync_shard_state(status, next_sync_at, country_code, shard_id);
CREATE INDEX IF NOT EXISTS idx_sync_source_execution_due ON sync_source_execution_state(state,next_attempt_at);
ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS adapter TEXT;
ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS failure_phase TEXT;
ALTER TABLE sync_source_execution_state ADD COLUMN IF NOT EXISTS failure_signature TEXT;
CREATE INDEX IF NOT EXISTS idx_sync_source_execution_failure_domain
  ON sync_source_execution_state(country_code,adapter,failure_phase,failure_signature,state);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_country_created ON sync_jobs(country_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cn_admin_parent ON cn_admin_areas(parent_adcode,level,name);
CREATE INDEX IF NOT EXISTS idx_cn_communities_location ON cn_communities_v2(city,district,active,normalized_name);
CREATE INDEX IF NOT EXISTS idx_cn_communities_publication_location ON cn_communities_v2(active,province,city,district,last_seen_at);
CREATE INDEX IF NOT EXISTS idx_cn_communities_generation ON cn_communities_v2(active,source_count DESC,id);
CREATE INDEX IF NOT EXISTS idx_cn_communities_generation_random
  ON cn_communities_v2(active,((hashtextextended(id,0) & 2147483647)));
CREATE INDEX IF NOT EXISTS idx_cn_communities_coordinate ON cn_communities_v2(latitude,longitude);
ALTER TABLE cn_communities_v2 ADD COLUMN IF NOT EXISTS postcode TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_cn_communities_postcode ON cn_communities_v2(postcode,active);
CREATE INDEX IF NOT EXISTS idx_cn_communities_city_random ON cn_communities_v2(city,active,((hashtextextended(id,0) & 2147483647)),id);
CREATE INDEX IF NOT EXISTS idx_cn_communities_province_random ON cn_communities_v2(province,active,((hashtextextended(id,0) & 2147483647)),id);
CREATE INDEX IF NOT EXISTS idx_cn_communities_district_random ON cn_communities_v2(district,active,((hashtextextended(id,0) & 2147483647)),id);
CREATE INDEX IF NOT EXISTS idx_cn_communities_postcode_random ON cn_communities_v2(postcode,active,((hashtextextended(id,0) & 2147483647)),id);
CREATE STATISTICS IF NOT EXISTS cn_communities_location_stats (dependencies, mcv) ON province, city, district FROM cn_communities_v2;
CREATE STATISTICS IF NOT EXISTS cn_communities_city_stats (dependencies, mcv) ON province, city FROM cn_communities_v2;
ALTER STATISTICS cn_communities_city_stats SET STATISTICS 1000;
CREATE INDEX IF NOT EXISTS idx_cn_community_sources_community ON cn_community_sources(community_id);
CREATE INDEX IF NOT EXISTS idx_cn_ingest_decision ON cn_ingest_candidates(decision,provider,adcode,last_seen_at);
CREATE INDEX IF NOT EXISTS idx_cn_ingest_location ON cn_ingest_candidates(city,district,decision);
CREATE INDEX IF NOT EXISTS idx_cn_sync_area_priority ON cn_sync_area_targets(enabled,priority,adcode);
CREATE INDEX IF NOT EXISTS idx_admin_coverage_parent ON admin_coverage_stats(parent_key,country_code,region_name);
CREATE INDEX IF NOT EXISTS idx_sync_node_overrides_country ON sync_node_overrides(country_code,level,node_key);
CREATE INDEX IF NOT EXISTS idx_address_pool_coordinates
  ON address_pool(country_code,latitude,longitude) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_country_random
  ON address_generation_index(country_code,random_key,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_country_residential_random
  ON address_generation_index(country_code,random_key,address_id)
  WHERE active=1 AND residential_ready=1;
ALTER TABLE address_generation_index ADD COLUMN IF NOT EXISTS country_rank BIGINT;
ALTER TABLE address_generation_index ADD COLUMN IF NOT EXISTS residential_rank BIGINT;
CREATE INDEX IF NOT EXISTS idx_generation_country_rank
  ON address_generation_index(country_code,country_rank,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_country_residential_rank
  ON address_generation_index(country_code,residential_rank,address_id)
  WHERE active=1 AND residential_ready=1;
CREATE INDEX IF NOT EXISTS idx_generation_admin1_random
  ON address_generation_index(country_code,admin1_key,random_key,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_admin1_code_random
  ON address_generation_index(country_code,admin1_code_key,random_key,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_locality_random
  ON address_generation_index(country_code,locality_key,random_key,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_postal_locality_random
  ON address_generation_index(country_code,postal_locality_key,random_key,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_district_random
  ON address_generation_index(country_code,district_key,random_key,address_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_generation_postcode_random
  ON address_generation_index(country_code,postcode_key,random_key,address_id) WHERE active=1;

UPDATE catalog_regions SET native_name='Fryslân'
WHERE country_code='NL' AND code='FR' AND native_name IN ('Frieland','Friesland');

UPDATE address_pool SET
  admin1='Fryslân',
  admin1_key='fryslân',
  component_variants_json=jsonb_set(
    jsonb_set(component_variants_json::jsonb, '{native,admin1}', to_jsonb('Fryslân'::text), true),
    '{en,admin1}', to_jsonb('Friesland'::text), true
  )::text,
  address_variants_json=jsonb_set(
    jsonb_set(address_variants_json::jsonb, '{native}',
      to_jsonb(replace(address_variants_json::jsonb->>'native', 'Frieland', 'Fryslân')), true),
    '{en}', to_jsonb(replace(address_variants_json::jsonb->>'en', 'Frieland', 'Friesland')), true
  )::text
WHERE country_code='NL' AND admin1='Frieland';

UPDATE residential_coverage SET region_name='Fryslân'
WHERE country_code='NL' AND region_name='Frieland';

DROP VIEW IF EXISTS address_pool_runtime;
CREATE VIEW address_pool_runtime AS
SELECT
  address_pool.*,
  address_pool_evidence.id AS evidence_id,
  address_pool_evidence.source_record_id,
  address_pool_evidence.record_url,
  address_pool_evidence.observed_at,
  address_pool_evidence.evidence_type,
  CASE WHEN EXISTS (
    SELECT 1 FROM address_pool_evidence residential_evidence
    JOIN address_datasets residential_dataset ON residential_dataset.id = residential_evidence.dataset_id
      AND residential_dataset.status = 'active' AND residential_dataset.redistribution_allowed = 1
    JOIN address_sources residential_source ON residential_source.id = residential_dataset.source_id
      AND residential_source.redistribution_allowed = 1
    WHERE residential_evidence.address_id = address_pool.id
      AND residential_evidence.evidence_type = 'residential_use'
      AND residential_evidence.is_current = 1
  ) THEN 1 ELSE 0 END AS residential_evidence,
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
  AND address_sources.redistribution_allowed = 1
WHERE address_pool.active = 1;

CREATE TABLE IF NOT EXISTS address_postcode_inference (
  address_id TEXT PRIMARY KEY REFERENCES address_pool(id) ON DELETE CASCADE,
  postcode TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  checked_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO schema_migrations(version, applied_at)
SELECT version, CURRENT_TIMESTAMP::text FROM generate_series(1, 37) AS version
ON CONFLICT (version) DO NOTHING;
