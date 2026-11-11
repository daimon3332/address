import { randomUUID } from 'node:crypto';
import { addressQualitySqlClause } from '../../src/domain/address-quality.mjs';
import { foreignAddressScriptPattern, semanticAddressFields } from '../../src/domain/address-localization.mjs';
import { administrativeKeySql, administrativeValueSql, refreshAdministrativeAssignments } from './administrative-assignments.mjs';

// English-first publication: a row publishes once its English variant is usable; Chinese fields still untranslated
// show their English form at read time and are replaced as translation recovery completes them. A field the English
// variant omits takes the value the reader gives it: the source column, the English city for an equal postal city, and
// the English district for the dependent locality.
const englishReaderValues = (prefix) => {
  const en = (field) => `${prefix}component_variants_json::jsonb -> 'en' ->> '${field}'`;
  return {
    buildingName: `coalesce(${en('buildingName')},${prefix}building_name)`,
    street: `coalesce(${en('street')},${prefix}street)`,
    locality: `coalesce(${en('locality')},nullif(${prefix}locality,''),${prefix}postal_locality)`,
    postalLocality: `coalesce(${en('postalLocality')},CASE WHEN ${en('locality')} IS NOT NULL
      AND lower(trim(${prefix}postal_locality))=lower(trim(${prefix}locality)) THEN ${en('locality')} ELSE ${prefix}postal_locality END)`,
    dependentLocality: `coalesce(${en('dependentLocality')},${en('district')})`,
    district: `coalesce(${en('district')},${prefix}district)`,
    admin1: `coalesce(${en('admin1')},${prefix}admin1)`
  };
};
export const addressLocalizationSqlClause = (prefix = '') => {
  const values = englishReaderValues(prefix);
  return `NOT (concat_ws('',${semanticAddressFields.map((field) => values[field]).join(',')}) ~ '${foreignAddressScriptPattern('en')}')`;
};

export const addressPublicationSqlClause = (prefix = '') => [
  `${prefix}quality_score >= 0.7`,
  addressQualitySqlClause(prefix),
  addressLocalizationSqlClause(prefix)
].join(' AND ');

export const generationIndexRowCount = async (database) => Number(
  await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total') || 0
);

// Targeted refreshes append ranks and retirements leave gaps; past this point the country is renumbered.
export const ranksNeedRenumbering = (maximum, total) => Number(maximum || 0) > Number(total || 0) * 1.25 + 1_000;

export const refreshAddressGenerationIndex = async (database, countryCode, { addressIds } = {}) => {
  const scope = String(countryCode || '').trim().toUpperCase();
  if (!scope) return 0;
  const ids = addressIds === undefined ? null : [...new Set(addressIds.map(String))];
  if (ids && !ids.length) return generationIndexRowCountForCountry(database, scope);
  await refreshAdministrativeAssignments(database, scope, { addressIds: ids || undefined });
  const placeholders = ids?.map(() => '?').join(',');
  const updatedAt = new Date().toISOString();
  const source = 'address_pool_runtime runtime';
  const eligible = addressPublicationSqlClause('runtime.');
  // The current maxima come from the rank indexes once; inlined as a subquery the planner re-evaluated them per row.
  const maximumRank = async (column, readiness) => Number(await database.prepare(`SELECT ${column} AS value FROM address_generation_index
    WHERE country_code=? AND active=1${readiness} AND ${column} IS NOT NULL ORDER BY ${column} DESC LIMIT 1`).bind(scope).first('value') || 0);
  const base = ids ? [await maximumRank('country_rank', ''), await maximumRank('residential_rank', ' AND residential_ready=1')] : [];
  // A targeted refresh keeps existing ranks and appends new rows after the current maximum, so publishing a
  // batch never renumbers the whole country; random selection tolerates the rare gap left by a deactivation.
  const rankedRows = ids ? `
      SELECT numbered.*,
        COALESCE(numbered.current_country_rank, base.country_rank + numbered.country_seq) AS country_rank,
        CASE WHEN numbered.ready=1 THEN COALESCE(numbered.current_residential_rank, base.residential_rank + numbered.residential_seq) END
          AS residential_rank
      FROM (
        SELECT eligible_runtime.*,
          ROW_NUMBER() OVER (PARTITION BY new_country ORDER BY random_key,id) AS country_seq,
          CASE WHEN new_residential=1 THEN ROW_NUMBER() OVER (PARTITION BY new_residential ORDER BY random_key,id) END AS residential_seq
        FROM (
          SELECT runtime.*,
            CASE WHEN runtime.property_type IN ('residential','apartment') AND runtime.residential_evidence=1 THEN 1 ELSE 0 END AS ready,
            current_index.country_rank AS current_country_rank,current_index.residential_rank AS current_residential_rank,
            CASE WHEN current_index.country_rank IS NULL THEN 1 ELSE 0 END AS new_country,
            CASE WHEN runtime.property_type IN ('residential','apartment') AND runtime.residential_evidence=1
              AND current_index.residential_rank IS NULL THEN 1 ELSE 0 END AS new_residential
          FROM ${source}
          LEFT JOIN address_generation_index current_index ON current_index.address_id=runtime.id AND current_index.active=1
          WHERE runtime.country_code=? AND runtime.id IN (${placeholders}) AND runtime.active=1 AND ${eligible}
        ) eligible_runtime
      ) numbered,
      (SELECT CAST(? AS bigint) AS country_rank,CAST(? AS bigint) AS residential_rank) base` : `
      SELECT eligible_runtime.*,
        ROW_NUMBER() OVER (ORDER BY random_key,id) AS country_rank,
        CASE WHEN ready=1 THEN ROW_NUMBER() OVER (PARTITION BY ready ORDER BY random_key,id) END AS residential_rank
      FROM (
        SELECT runtime.*,
          CASE WHEN runtime.property_type IN ('residential','apartment') AND runtime.residential_evidence=1 THEN 1 ELSE 0 END AS ready
        FROM ${source}
        WHERE runtime.country_code=? AND runtime.active=1 AND ${eligible}
      ) eligible_runtime`;
  await database.batch([
    ...(ids ? [] : [database.prepare('UPDATE address_generation_index SET active=0 WHERE country_code=?').bind(scope)]),
    database.prepare(`
    INSERT INTO address_generation_index(
      address_id,country_code,admin1_key,admin1_code_key,locality_key,postal_locality_key,
      district_key,postcode_key,locality,postal_locality,district,postcode,street,house_number,
      building_name,search_text,random_key,country_rank,residential_rank,residential_ready,active,source_revision,updated_at
    ) SELECT ranked.id,ranked.country_code,${administrativeKeySql('admin1', 'ranked')},${administrativeKeySql('admin1_code', 'ranked')},
      ${administrativeKeySql('locality', 'ranked')},ranked.postal_locality_key,ranked.district_key,ranked.postcode_key,
      ${administrativeValueSql('locality', 'ranked')},ranked.postal_locality,ranked.district,ranked.postcode,ranked.street,
      ranked.house_number,ranked.building_name,
      lower(concat_ws(' ',ranked.house_number,ranked.street,ranked.building_name,ranked.district,
        ${administrativeValueSql('locality', 'ranked')},ranked.postal_locality,${administrativeValueSql('admin1', 'ranked')},
        ${administrativeValueSql('admin1_code', 'ranked')},ranked.postcode)),
      ranked.random_key,ranked.country_rank,ranked.residential_rank,ranked.ready,
      1,concat_ws(':',ranked.dataset_id,ranked.dataset_version),?
    FROM (${rankedRows}
    ) ranked
    ON CONFLICT(address_id) DO UPDATE SET
      country_code=excluded.country_code,admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      search_text=excluded.search_text,random_key=excluded.random_key,country_rank=excluded.country_rank,
      residential_rank=excluded.residential_rank,residential_ready=excluded.residential_ready,
      active=1,source_revision=excluded.source_revision,updated_at=excluded.updated_at
  `).bind(updatedAt, scope, ...(ids ? [...ids, ...base] : [])),
    ...(ids ? [database.prepare(`UPDATE address_generation_index SET active=0
      WHERE country_code=? AND address_id IN (${placeholders}) AND updated_at<>?`).bind(scope, ...ids, updatedAt)] : []),
    database.prepare(`INSERT INTO address_pool_revisions(kind,version) VALUES (?,?)
      ON CONFLICT(kind) DO UPDATE SET version=excluded.version`).bind(`generation:${scope}`, randomUUID())
  ]);
  return generationIndexRowCountForCountry(database, scope);
};

// DISTINCT over the whole pool reads every row (over ten minutes on production); stepping from one country to the
// next reads one index entry per country.
export const activePoolCountries = async (database) => {
  const countries = new Set();
  for (let previous = ''; ;) {
    const next = await database.prepare(`SELECT country_code FROM address_pool
      WHERE active=1 AND country_code>? ORDER BY country_code LIMIT 1`).bind(previous).first('country_code');
    if (!next) return countries;
    countries.add(previous = next);
  }
};

// Each country is checked on its own so one large country cannot push a whole-pool scan past the statement timeout.
export const refreshStaleAddressGenerationIndexes = async (database) => {
  const eligible = addressPublicationSqlClause('runtime.');
  const countries = (await database.prepare(`SELECT country_code FROM sync_country_policies
    UNION SELECT DISTINCT country_code FROM address_generation_index ORDER BY country_code`).all()).results || [];
  const populated = await activePoolCountries(database);
  const refreshed = [];
  const failed = [];
  for (const { country_code: countryCode } of countries) {
    try {
      const source = !populated.has(countryCode) ? null : await database.prepare(`SELECT COUNT(DISTINCT runtime.id) AS source_count,
          COUNT(DISTINCT generation.address_id) AS matched_index_count
        FROM address_pool_runtime runtime
        LEFT JOIN address_generation_index generation ON generation.address_id=runtime.id
          AND generation.country_code=runtime.country_code AND generation.active=1
        WHERE runtime.country_code=? AND runtime.active=1 AND ${eligible}`).bind(countryCode).first();
      const index = await database.prepare(`SELECT COUNT(*) FILTER (WHERE active=1) AS index_count,
          MAX(country_rank) FILTER (WHERE active=1) AS maximum_rank,
          COUNT(*) FILTER (WHERE active=1 AND country_rank IS NULL) AS missing_ranks,
          COUNT(*) FILTER (WHERE active=1 AND residential_ready=1 AND residential_rank IS NULL) AS missing_residential_ranks
        FROM address_generation_index WHERE country_code=?`).bind(countryCode).first();
      const sourceCount = Number(source?.source_count || 0);
      if (sourceCount === Number(index?.index_count || 0) && sourceCount === Number(source?.matched_index_count || 0)
        && !Number(index?.missing_ranks || 0) && !Number(index?.missing_residential_ranks || 0)
        && !ranksNeedRenumbering(index?.maximum_rank, index?.index_count)) continue;
      await refreshAddressGenerationIndex(database, countryCode);
      refreshed.push(countryCode);
    } catch (error) {
      failed.push(`${countryCode}:${error?.code || error?.message || error}`);
    }
  }
  if (failed.length) throw Object.assign(new Error(`Generation index consistency failed for ${failed.join(', ')}`), { refreshed });
  return refreshed;
};

const generationIndexRowCountForCountry = async (database, countryCode) => Number(
  await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE country_code=? AND active=1')
    .bind(countryCode).first('total') || 0
);

export const refreshAddressGenerationIndexIfEmpty = async (database, countryCodes) => {
  let refreshed = false;
  for (const countryCode of countryCodes) {
    if (await generationIndexRowCountForCountry(database, countryCode)) continue;
    await refreshAddressGenerationIndex(database, countryCode);
    refreshed = true;
  }
  return refreshed;
};
