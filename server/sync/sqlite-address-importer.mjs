const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const postcodeKey = (value) => cleanKey(value).replace(/\s/gu, '');
const randomKey = (hash) => Number.parseInt(hash.slice(0, 8), 16) & 0x7fffffff;
const expiry = (date) => new Date(date.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
const DEFAULT_MINIMUM_RATIO = 0.7;

// Minimum administrative completeness per country. A record must carry at least
// one region-level field and (where listed) a city-level field, else it is dropped.
const requiredAdminFields = {
  CN: { region: true, city: true, district: true }, IN: { region: true, city: true }, VN: { region: true, city: true },
  TH: { region: true, city: true }, US: { region: true, city: true }, CA: { region: true, city: true },
  JP: { region: true, city: true }, MX: { region: true, city: true }, BR: { region: true, city: true },
  AU: { region: true, city: true }, KR: { region: true, city: true }, MY: { region: true, city: true },
  PH: { region: true, city: true }, TR: { region: true, city: true }, RU: { region: true, city: true },
  DE: { region: false, city: true }, FR: { region: false, city: true }, IT: { region: false, city: true },
  ES: { region: false, city: true }, NL: { region: false, city: true }, GB: { region: false, city: true },
  SA: { region: false, city: true }, NG: { region: true, city: true }, ZA: { region: false, city: true },
  TW: { region: true, city: true }, HK: { region: false, city: true }, SG: { region: false, city: false }
};

const hasRegion = (components) => Boolean((components.admin1 || '').trim() || (components.admin1Code || '').trim());
const hasCity = (components) => Boolean(
  (components.locality || '').trim() || (components.postalLocality || '').trim() || (components.district || '').trim()
);

// Countries whose admin hierarchy is rebuilt from coordinates, overriding
// untrustworthy source text (OSM stores district names in the city field, mixes
// scripts, etc.). Only CN has both severe misplacement and a dense enough catalog.
const geoAnchorCountries = new Set(['CN']);

// Rule-based soft fixes for countries with locality-level misplacement but a
// catalog too sparse (TW) or a defect rate too low (RU) for full re-anchoring.
// `demote` matches a locality that is NOT a city; `replaceWith: 'admin1'` uses the
// admin1 name as the city (TW 縣市), `'anchor'` uses the coordinate-nearest
// catalog city (RU район records).
const softLocalityFixes = {
  TW: { demote: /[里村]$/u, replaceWith: 'admin1' },
  RU: { demote: /район|поселение|сельсовет|городской округ/iu, replaceWith: 'anchor' }
};

// Fills empty admin fields via catalog reverse-geocoding, then enforces the
// country's minimum administrative completeness. Returns false to drop the record.
const enrichAndValidate = (record, geocoder, countryCode, rebuildFormattedAddress) => {
  const components = record.components;
  if (geoAnchorCountries.has(countryCode) && geocoder?.hierarchyReady) {
    // Cross-border source label guard: china.pbf carries Taiwan/HK/Macau points.
    const sourceRegion = `${components.admin1 || ''} ${record.admin1 || ''}`;
    if (countryCode === 'CN') {
      if (/香港|澳門|澳门|台湾|臺灣|hong\s?kong|macau|macao|taiwan/iu.test(sourceRegion)) return false;
      // Russian/Mongolian border streets leak Cyrillic; a CN street is never Cyrillic.
      if (/[Ѐ-ӿ]/u.test(`${components.street || ''} ${components.buildingName || ''}`)) return false;
    }
    const anchored = geocoder.resolveHierarchy(Number(record.latitude), Number(record.longitude), {
      sourceAdmin1: components.admin1 || record.admin1 || ''
    });
    // No city-tier anchor within range => point is off-grid or cross-border; drop.
    if (!anchored) return false;
    components.admin1 = anchored.admin1;
    components.admin1Code = anchored.admin1Code || components.admin1Code || '';
    components.locality = anchored.city;
    components.postalLocality = anchored.city;
    if (anchored.district) {
      components.district = anchored.district;
      components.dependentLocality = anchored.district;
      record.district = anchored.district;
    } else {
      components.district = '';
      components.dependentLocality = '';
      record.district = '';
    }
    record.englishComponentHints = {
      ...(record.englishComponentHints || {}),
      admin1: anchored.admin1En, locality: anchored.cityEn,
      ...(anchored.districtEn ? { district: anchored.districtEn } : {})
    };
    record.chineseComponentHints = {
      ...(record.chineseComponentHints || {}),
      admin1: anchored.admin1Zh || anchored.admin1, locality: anchored.cityZh || anchored.city,
      ...(anchored.districtZh || anchored.district ? { district: anchored.districtZh || anchored.district } : {})
    };
    record.admin1 = components.admin1;
    record.admin1Code = components.admin1Code;
    record.locality = components.locality;
    record.postalLocality = components.postalLocality;
    // OSM name tags sometimes hold "中文 English" in one value; keep the Han part
    // as native and route the Latin part to the English hint (Han-script countries only).
    if (countryCode === 'CN' || countryCode === 'TW') {
      for (const field of ['street', 'buildingName']) {
        const value = String(components[field] || '').trim();
        const mixed = value.match(/^([^A-Za-z]*\p{Script=Han}[^A-Za-z]*)\s+([A-Za-z][A-Za-z' .’-]+)$/u);
        if (mixed) {
          components[field] = mixed[1].trim();
          record.englishComponentHints[field] = record.englishComponentHints[field] || mixed[2].trim();
          if (field === 'street') record.street = components.street;
          if (field === 'buildingName') record.buildingName = components.buildingName;
        }
      }
    }
    if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    const policy = requiredAdminFields[countryCode] || { region: false, city: false };
    if (policy.region && !hasRegion(components)) return false;
    if (policy.city && !hasCity(components)) return false;
    if (policy.district && !(components.district || '').trim()) return false;
    return true;
  }
  const softFix = softLocalityFixes[countryCode];
  if (softFix) {
    const locality = String(components.locality || '').trim();
    if (locality && softFix.demote.test(locality)) {
      // Preserve the fine-grained name for sampling-bucket diversity before replacing.
      record.samplingLocality = locality;
      let replacement = '';
      if (softFix.replaceWith === 'admin1') {
        replacement = String(components.admin1 || record.admin1 || '').trim();
      } else if (softFix.replaceWith === 'anchor' && geocoder?.hierarchyReady) {
        const anchored = geocoder.resolveHierarchy(Number(record.latitude), Number(record.longitude), {
          sourceAdmin1: components.admin1 || record.admin1 || ''
        });
        const city = String(anchored?.city || '').trim();
        replacement = city && !softFix.demote.test(city) ? city : '';
      }
      if (!replacement) return false;
      components.locality = replacement;
      if (components.postalLocality && softFix.demote.test(components.postalLocality)) {
        components.postalLocality = replacement;
      }
      record.locality = replacement;
      if (record.postalLocality && softFix.demote.test(record.postalLocality)) record.postalLocality = replacement;
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  if (geocoder?.available) {
    const filled = geocoder.lookup(record);
    let enriched = false;
    if (filled.admin1 && (!components.admin1 || filled.replaceRegion)) {
      components.admin1 = filled.admin1;
      if (filled.admin1Code) components.admin1Code = filled.admin1Code;
      record.englishComponentHints = record.englishComponentHints || {};
      if (filled.admin1En) record.englishComponentHints.admin1 = filled.admin1En;
      if (filled.admin1Zh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: filled.admin1Zh };
      enriched = true;
    }
    if (filled.locality && (!components.locality || filled.replaceCity)) {
      components.locality = filled.locality;
      if (filled.replaceCity && components.postalLocality) components.postalLocality = filled.locality;
      record.englishComponentHints = record.englishComponentHints || {};
      if (filled.localityEn) record.englishComponentHints.locality = filled.localityEn;
      if (filled.localityZh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), locality: filled.localityZh };
      enriched = true;
    }
    if (enriched) {
      record.admin1 = components.admin1 || '';
      record.admin1Code = components.admin1Code || record.admin1Code || '';
      record.locality = components.locality || '';
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  const policy = requiredAdminFields[countryCode] || { region: false, city: false };
  if (policy.region && !hasRegion(components)) return false;
  if (policy.city && !hasCity(components)) return false;
  if (policy.district && !(components.district || '').trim()) return false;
  // Cross-border leakage guard: a mainland-China record must never carry an HK/Macau region.
  if (countryCode === 'CN') {
    const region = `${components.admin1 || ''} ${record.admin1 || ''}`;
    if (/香港|澳門|澳门|hong\s?kong|macau|macao/iu.test(region)) return false;
  }
  return true;
};
const IMPORT_REVISION = 'geo-anchor-v13';

export class SnapshotQualityError extends Error {
  constructor(shardId, failures, metrics) {
    super(`Shard ${shardId} failed snapshot quality gates: ${failures.join('; ')}`);
    this.name = 'SnapshotQualityError';
    this.code = 'SNAPSHOT_QUALITY_FAILED';
    this.metrics = metrics;
  }
}

const coverageKey = (record) => [
  'sync', record.countryCode, cleanKey(record.admin1Code || record.admin1) || '*',
  cleanKey(record.postalLocality || record.locality) || '*', record.propertyType
].join(':');

const variants = (record) => ({
  components: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, record.localizations[language].components])),
  addresses: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, record.localizations[language].formattedAddress]))
});

const sourceStatement = (database, shard, observedAt) => database.prepare(`
  INSERT INTO address_sources(
    id,name,homepage_url,data_url,license_code,license_name,license_url,attribution_text,
    attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,metadata_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,data_url=excluded.data_url,license_code=excluded.license_code,
    license_name=excluded.license_name,license_url=excluded.license_url,
    attribution_text=excluded.attribution_text,attribution_url=excluded.attribution_url,
    terms_url=excluded.terms_url,share_alike=excluded.share_alike,
    notice_required=excluded.notice_required,redistribution_allowed=excluded.redistribution_allowed,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
`).bind(
  shard.source.id, shard.source.name, shard.source.homepageUrl, shard.source.dataUrl,
  shard.source.licenseCode, shard.source.licenseName, shard.source.licenseUrl,
  shard.source.attributionText, shard.source.attributionUrl, shard.source.termsUrl,
  Number(Boolean(shard.source.shareAlike)), Number(Boolean(shard.source.noticeRequired)),
  Number(shard.source.redistributionAllowed !== false), JSON.stringify({ adapter: shard.source.adapter }),
  observedAt, observedAt
);

const datasetStatement = (database, { datasetId, shard, discovery, materialized, observedAt }) => database.prepare(`
  INSERT INTO address_datasets(
    id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
    license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
    share_alike,notice_required,redistribution_allowed,accepted_count,rejected_count,active_count,status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
  ON CONFLICT(id) DO UPDATE SET retrieved_at=excluded.retrieved_at,imported_at=excluded.imported_at,status='pending'
`).bind(
  datasetId, shard.source.id, shard.countryCode, `${String(discovery.version)}-${IMPORT_REVISION}`, discovery.publishedAt || null,
  observedAt, observedAt, materialized.checksum, materialized.format,
  shard.source.licenseCode, shard.source.licenseName, shard.source.licenseUrl,
  shard.source.attributionText, shard.source.attributionUrl, shard.source.termsUrl,
  Number(Boolean(shard.source.shareAlike)), Number(Boolean(shard.source.noticeRequired)),
  Number(shard.source.redistributionAllowed !== false), 0, 0, 0
);

const addressStatements = (database, records, context) => {
  const addressBindings = [];
  const addressRows = records.map((record) => {
    const localized = variants(record);
    const coverage = coverageKey(record);
    addressBindings.push(
      record.id, record.countryCode, record.admin1, record.admin1Code, record.locality, record.postalLocality,
      record.district, record.postcode, record.street, record.houseNumber, record.buildingName,
      record.latitude, record.longitude, record.nativeLanguage, JSON.stringify(localized.components),
      JSON.stringify(localized.addresses), cleanKey(record.admin1), cleanKey(record.admin1Code),
      cleanKey(record.locality), cleanKey(record.postalLocality), cleanKey(record.district), postcodeKey(record.postcode),
      record.propertyType, record.qualityScore, context.datasetId, coverage, randomKey(record.canonicalHash),
      context.observedAt, context.observedAt, context.expiresAt
    );
    return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,NULL)';
  });
  const address = database.prepare(`
    INSERT INTO address_pool(
      id,country_code,admin1,admin1_code,locality,postal_locality,district,postcode,street,house_number,
      building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
      admin1_key,admin1_code_key,locality_key,postal_locality_key,district_key,postcode_key,property_type,
      quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,expires_at,retired_at
    ) VALUES ${addressRows.join(',')}
    ON CONFLICT(id) DO UPDATE SET
      admin1=excluded.admin1,admin1_code=excluded.admin1_code,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      latitude=excluded.latitude,longitude=excluded.longitude,native_language=excluded.native_language,
      component_variants_json=excluded.component_variants_json,address_variants_json=excluded.address_variants_json,
      admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,
      property_type=excluded.property_type,quality_score=max(address_pool.quality_score,excluded.quality_score),
      generation=excluded.generation,coverage=excluded.coverage,active=1,last_seen_at=excluded.last_seen_at,
      expires_at=excluded.expires_at,retired_at=NULL
  `).bind(...addressBindings);
  const evidenceBindings = [];
  const evidenceRows = records.flatMap((record) => {
    const evidence = [{ type: 'address_existence', sourceRecordId: record.sourceRecordId }];
    if (record.propertyType === 'residential' || record.propertyType === 'apartment') {
      evidence.push({ type: 'residential_use', sourceRecordId: record.residentialSourceRecordId || record.sourceRecordId });
    }
    return evidence.map(({ type, sourceRecordId }) => {
        evidenceBindings.push(
          context.hash(`${context.datasetId}\u001f${sourceRecordId}\u001f${type}`),
          record.id, context.datasetId, sourceRecordId, context.discovery.dataUrl || '', context.observedAt,
          type, context.observedAt
        );
        return '(?,?,?,?,?,?,?,0,1,?)';
      });
  });
  const evidence = database.prepare(`
      INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES ${evidenceRows.join(',')}
      ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,is_current=1
    `).bind(...evidenceBindings);
  return [address, evidence];
};

export class SqliteAddressImporter {
  constructor({ database, normalizeRecord, localizeRecords, hash, reverseGeocoder, rebuildFormattedAddress }) {
    this.database = database;
    this.normalizeRecord = normalizeRecord;
    this.localizeRecords = localizeRecords;
    this.hash = hash;
    this.reverseGeocoder = reverseGeocoder;
    this.rebuildFormattedAddress = rebuildFormattedAddress;
  }

  async importShard({ shard, discovery, materialized, maxRecords, perLocality, batchSize = 800 }) {
    const datasetId = `${shard.id}-${String(discovery.version).replace(/[^a-zA-Z0-9._-]/gu, '_')}-${materialized.checksum.slice(0, 12)}-${IMPORT_REVISION}`;
    const existing = await this.database.prepare("SELECT status,active_count FROM address_datasets WHERE id=?").bind(datasetId).first();
    if (existing?.status === 'active') {
      return { datasetId, acceptedCount: Number(existing.active_count), rejectedCount: 0, skipped: true };
    }

    const seen = new Set();
    const localityCounts = new Map();
    const records = [];
    let rejectedCount = 0;
    const geocoder = this.reverseGeocoder ? await this.reverseGeocoder(shard.countryCode) : null;
    for await (const value of readJsonLines(materialized.file)) {
      const record = this.normalizeRecord(value, shard, materialized.format);
      if (!record || seen.has(record.canonicalHash)) {
        rejectedCount += 1;
        continue;
      }
      if (!enrichAndValidate(record, geocoder, shard.countryCode, this.rebuildFormattedAddress)) {
        rejectedCount += 1;
        continue;
      }
      const cityName = cleanKey(record.samplingLocality || record.components.locality || record.components.postalLocality || record.postcode || '');
      // Geo-anchored countries collapse into few prefecture-city buckets, so the
      // sampling cap keys on city:district to keep per-district coverage instead.
      const districtName = geoAnchorCountries.has(shard.countryCode)
        ? cleanKey(record.components.district || '')
        : '';
      const localityName = districtName ? `${cityName}:${districtName}` : cityName;
      const locality = localityName
        || (Number.isFinite(record.longitude) && Number.isFinite(record.latitude)
          ? `grid:${Math.floor(record.longitude * 10)}:${Math.floor(record.latitude * 10)}`
          : '*');
      const count = localityCounts.get(locality) || 0;
      if (count >= perLocality || records.length >= maxRecords) continue;
      localityCounts.set(locality, count + 1);
      seen.add(record.canonicalHash);
      records.push(record);
    }
    if (!records.length) throw new Error(`Shard ${shard.id} produced no valid addresses`);

    const localized = [];
    for (let offset = 0; offset < records.length; offset += batchSize) {
      localized.push(...await this.localizeRecords(records.slice(offset, offset + batchSize)));
    }
    const candidateAdmin1Count = new Set(localized
      .map((record) => cleanKey(record.admin1Code || record.admin1 || record.district))
      .filter(Boolean)).size;
    const previous = await this.database.prepare(`SELECT dataset.id,dataset.active_count,
      COUNT(DISTINCT coalesce(nullif(trim(pool.admin1_key),''),nullif(trim(pool.district_key),''))) AS admin1_count
      FROM address_datasets dataset
      LEFT JOIN address_pool_evidence evidence ON evidence.dataset_id=dataset.id
        AND evidence.evidence_type='address_existence' AND evidence.is_current=1
      LEFT JOIN address_pool pool ON pool.id=evidence.address_id AND pool.active=1
      WHERE dataset.source_id=? AND dataset.country_code=? AND dataset.status='active'
      GROUP BY dataset.id,dataset.active_count ORDER BY dataset.imported_at DESC LIMIT 1`
    ).bind(shard.source.id, shard.countryCode).first();
    const configuredGate = shard.qualityGate || {};
    const compactMinimum = shard.countryCode === 'SG' ? 50 : shard.countryCode === 'HK' ? 500 : 1_000;
    const minimumRecords = configuredGate.minimumRecords
      ?? (maxRecords >= 1_000 ? Math.max(10, Math.min(compactMinimum, Math.ceil(maxRecords * 0.01))) : 1);
    const minimumAdmin1 = configuredGate.minimumAdmin1
      ?? (shard.countryCode === 'SG' ? 0 : maxRecords >= 1_000 && shard.countryCode !== 'HK' ? 2 : 1);
    const minimumCountRatio = configuredGate.minimumCountRatio ?? DEFAULT_MINIMUM_RATIO;
    const minimumAdmin1Ratio = configuredGate.minimumAdmin1Ratio ?? DEFAULT_MINIMUM_RATIO;
    const metrics = {
      candidateCount: localized.length,
      candidateAdmin1Count,
      previousCount: Number(previous?.active_count || 0),
      previousAdmin1Count: Number(previous?.admin1_count || 0),
      minimumRecords,
      minimumAdmin1,
      minimumCountRatio,
      minimumAdmin1Ratio
    };
    const failures = [];
    if (metrics.candidateCount < minimumRecords) failures.push(`count ${metrics.candidateCount} < ${minimumRecords}`);
    if (metrics.candidateAdmin1Count < minimumAdmin1) failures.push(`admin1 coverage ${metrics.candidateAdmin1Count} < ${minimumAdmin1}`);
    // Ratio gates only compare snapshots produced by the same import methodology; a revision
    // change intentionally replaces the sampling/enrichment rules, so the old counts are not a baseline.
    const sameRevision = Boolean(previous?.id && String(previous.id).endsWith(`-${IMPORT_REVISION}`));
    if (sameRevision) {
      const previousCountFloor = Math.ceil(Math.min(
        metrics.previousCount * minimumCountRatio,
        maxRecords * minimumCountRatio
      ));
      if (metrics.previousCount && metrics.candidateCount < previousCountFloor) {
        failures.push(`count ${metrics.candidateCount} < capped previous floor ${previousCountFloor}`);
      }
      if (metrics.previousAdmin1Count && metrics.candidateAdmin1Count < Math.ceil(metrics.previousAdmin1Count * minimumAdmin1Ratio)) {
        failures.push(`admin1 ratio ${(metrics.candidateAdmin1Count / metrics.previousAdmin1Count).toFixed(3)} < ${minimumAdmin1Ratio}`);
      }
    }
    if (failures.length) throw new SnapshotQualityError(shard.id, failures, metrics);
    const observedAt = new Date().toISOString();
    const context = { datasetId, discovery, observedAt, expiresAt: expiry(new Date(observedAt)), hash: this.hash };
    const coverage = new Map();
    for (const record of localized) {
      const key = coverageKey(record);
      const entry = coverage.get(key) || { record, count: 0, residential: 0 };
      entry.count += 1;
      if (record.propertyType === 'residential' || record.propertyType === 'apartment') entry.residential += 1;
      coverage.set(key, entry);
    }

    await this.database.exec('BEGIN IMMEDIATE');
    try {
      await this.database.batch([
        sourceStatement(this.database, shard, observedAt),
        datasetStatement(this.database, { datasetId, shard, discovery, materialized, observedAt })
      ]);
      for (let offset = 0; offset < localized.length; offset += batchSize) {
        await this.database.batch(addressStatements(this.database, localized.slice(offset, offset + batchSize), context));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await this.database.batch([
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0
          WHERE is_primary=1 AND address_id IN (
            SELECT address_id FROM address_pool_evidence WHERE dataset_id=? AND evidence_type='address_existence'
          )`).bind(datasetId),
        this.database.prepare("UPDATE address_pool_evidence SET is_primary=1,is_current=1 WHERE dataset_id=? AND evidence_type='address_existence'").bind(datasetId),
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0,is_current=0
          WHERE dataset_id IN (SELECT id FROM address_datasets WHERE country_code=? AND id<>?)`).bind(shard.countryCode, datasetId),
        this.database.prepare(`UPDATE address_pool SET active=0,retired_at=?
          WHERE country_code=? AND active=1 AND NOT EXISTS (
            SELECT 1 FROM address_pool_evidence evidence
            JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
            WHERE evidence.address_id=address_pool.id AND evidence.is_current=1
              AND evidence.evidence_type='address_existence' AND dataset.status IN ('pending','active')
          )`).bind(observedAt, shard.countryCode),
        this.database.prepare("UPDATE address_datasets SET status='retired',active_count=0 WHERE country_code=? AND id<>? AND status='active'").bind(shard.countryCode, datasetId),
        this.database.prepare("UPDATE address_datasets SET status='active',accepted_count=?,rejected_count=?,active_count=? WHERE id=?")
          .bind(localized.length, rejectedCount, localized.length, datasetId)
      ]);
      const coverageEntries = [...coverage];
      for (let offset = 0; offset < coverageEntries.length; offset += batchSize) {
        await this.database.batch(coverageEntries.slice(offset, offset + batchSize).map(([key, entry]) =>
          this.database.prepare(`INSERT INTO pool_coverage(
            coverage_key,country_code,admin1_key,locality_key,postcode_key,property_type,target_count,
            active_count,shadow_count,residential_count,refresh_status,generation,last_refreshed_at,expires_at
          ) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)
          ON CONFLICT(coverage_key) DO UPDATE SET active_count=excluded.active_count,
            residential_count=excluded.residential_count,refresh_status=excluded.refresh_status,
            generation=excluded.generation,last_refreshed_at=excluded.last_refreshed_at,expires_at=excluded.expires_at`
          ).bind(
            key, shard.countryCode, cleanKey(entry.record.admin1Code || entry.record.admin1),
            cleanKey(entry.record.postalLocality || entry.record.locality), postcodeKey(entry.record.postcode),
            entry.record.propertyType, perLocality, entry.count, entry.residential,
            entry.count >= perLocality ? 'ready' : 'low', datasetId, observedAt, context.expiresAt
          )));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await this.database.prepare(`UPDATE pool_coverage SET
        active_count=(SELECT COUNT(*) FROM address_pool WHERE address_pool.coverage=pool_coverage.coverage_key AND address_pool.active=1),
        residential_count=(SELECT COUNT(*) FROM address_pool WHERE address_pool.coverage=pool_coverage.coverage_key
          AND address_pool.active=1 AND address_pool.property_type IN ('residential','apartment')),
        refresh_status=CASE
          WHEN (SELECT COUNT(*) FROM address_pool WHERE address_pool.coverage=pool_coverage.coverage_key AND address_pool.active=1)>=target_count THEN 'ready'
          ELSE 'low'
        END
        WHERE country_code=?`).bind(shard.countryCode).run();
      await this.importCommunities(shard, materialized, batchSize);
      await this.database.exec('COMMIT');
    } catch (error) {
      await this.database.exec('ROLLBACK').catch(() => {});
      throw error;
    }
    const residentialCount = localized.filter((record) => record.propertyType === 'residential' || record.propertyType === 'apartment').length;
    return {
      datasetId, acceptedCount: localized.length, rejectedCount, localityCount: localityCounts.size,
      admin1Count: candidateAdmin1Count, residentialCount, skipped: false
    };
  }

  // Real Chinese residential communities extracted from the same china.pbf pass
  // (landuse=residential / place=neighbourhood with names). Replaces the whole
  // table per snapshot; institution + custom blacklists filter estate names.
  async importCommunities(shard, materialized, batchSize) {
    if (shard.countryCode !== 'CN') return;
    const sidecar = `${materialized.file}.communities.jsonl`;
    const { findNonResidentialMatch } = await import('../../src/domain/non-residential.mjs');
    const { matchesCustomBlacklist } = await import('../lib/custom-blacklist.mjs');
    const { pinyin } = await import('pinyin-pro');
    const { Converter } = await import('opencc-js/t2cn');
    const toSimplified = Converter({ from: 'hk', to: 'cn' });
    const romanize = (value) => {
      try {
        const words = pinyin(toSimplified(String(value || '')), { toneType: 'none', type: 'array' })
          .map((word) => word.trim()).filter(Boolean);
        const joined = words.map((word) => /^[a-z]/i.test(word) ? word : '').join('');
        return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : '';
      } catch {
        return '';
      }
    };
    const entries = [];
    try {
      for await (const value of readJsonLines(sidecar)) {
        const name = String(value?.name || '').trim();
        const latitude = Number(value?.latitude);
        const longitude = Number(value?.longitude);
        if (!name || name.length > 40 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        if (findNonResidentialMatch({ countryCode: 'CN', buildingName: name }).excluded) continue;
        if (matchesCustomBlacklist([name])) continue;
        entries.push({ name, nameEn: romanize(name), latitude, longitude });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!entries.length) return;
    await this.database.exec(`CREATE TABLE IF NOT EXISTS cn_communities(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_en TEXT NOT NULL DEFAULT '',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL
    )`);
    await this.database.exec('CREATE INDEX IF NOT EXISTS idx_cn_communities_lat ON cn_communities(latitude)');
    await this.database.prepare('DELETE FROM cn_communities').run();
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      await this.database.batch(entries.slice(offset, offset + batchSize).map((entry) =>
        this.database.prepare('INSERT INTO cn_communities(name,name_en,latitude,longitude) VALUES (?,?,?,?)')
          .bind(entry.name, entry.nameEn, entry.latitude, entry.longitude)));
      await new Promise((resolveTick) => setImmediate(resolveTick));
    }
  }

  async close() {}
}

async function* readJsonLines(file) {
  const { createReadStream } = await import('node:fs');
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const text = line.replace(/^\u001e/u, '').trim();
      if (text) yield JSON.parse(text);
    }
  }
  if (pending) {
    const line = pending;
    const text = line.replace(/^\u001e/u, '').trim();
    if (text) yield JSON.parse(text);
  }
}
