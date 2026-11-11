import { createHash } from 'node:crypto';
import { chinaEnglishComponent, chinaEnglishPremiseNumber } from '../../../src/domain/china-address-language';
import type { Database } from '../../database/database.mjs';
import type { AddressComponents, AddressEvidence, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters } from './address-repository';
import { matchesCustomBlacklist } from '../../lib/custom-blacklist.mjs';
import { chinaDeliveryAddressClause, normalizeChinaProviderAddress, withoutTrailingCommunityName } from '../../china/quality';

interface CommunityCandidateRow {
  id: string; canonical_name: string; province: string; city: string; district: string; township: string;
  postcode: string; provider_address: string; latitude: number; longitude: number; verification_level: 'L1' | 'L2' | 'L3';
  source_count: number; last_seen_at: string;
}

interface CommunityRow extends CommunityCandidateRow { providers: string }

const mainlandProvinceNames = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省',
  '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省',
  '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省', '云南省',
  '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区'
];
const mainlandProvinceSql = mainlandProvinceNames.map((name) => `'${name}'`).join(',');

const loadCommunityProviders = async (database: Database, communityId: string): Promise<string> => {
  const rows = (await database.prepare(`SELECT DISTINCT provider FROM cn_community_sources
    WHERE community_id=? AND ${chinaFreshTimestampClause('last_seen_at')} ORDER BY provider`)
    .bind(communityId).all<{ provider: string }>()).results;
  return rows.map((row) => row.provider).join(',');
};

export const chinaFreshTimestampClause = (column: string): string =>
  `${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'`;
export const chinaFreshSourceCountClause = (communityAlias = 'community', sourceAlias = 'fresh_source'): string => `(
  SELECT COUNT(DISTINCT ${sourceAlias}.provider) FROM cn_community_sources ${sourceAlias}
  WHERE ${sourceAlias}.community_id=${communityAlias}.id AND ${chinaFreshTimestampClause(`${sourceAlias}.last_seen_at`)}
)`;
export const chinaCommunityPublicationClause = (alias = 'community'): string => [
  `${alias}.active=1`,
  `${alias}.province IN (${mainlandProvinceSql})`,
  `(${alias}.city <> ${alias}.district OR concat(${alias}.province,'/',${alias}.city) IN (
    SELECT concat(direct_province.name,'/',direct_city.name) FROM cn_admin_areas direct_district
    JOIN cn_admin_areas direct_city ON direct_city.adcode=direct_district.parent_adcode AND direct_city.level='city'
    JOIN cn_admin_areas direct_province ON direct_province.adcode=direct_city.parent_adcode AND direct_province.level='province'
    WHERE direct_district.level='district' AND direct_city.name=direct_district.name
  ))`,
  chinaFreshTimestampClause(`${alias}.last_seen_at`),
  chinaDeliveryAddressClause(alias),
  `(${alias}.postcode ~ '^[0-9]{6}$' OR NOT EXISTS (SELECT 1 FROM catalog_postcodes WHERE country_code='CN'))`,
  `${alias}.provider_address ~ '^([^A-Za-z]|[A-Za-z](区|座|栋|棟|幢|单元|室|号|號|楼|组团|期))*$'`,
  `${alias}.canonical_name ~ '^([^A-Za-z]|[A-Za-z](区|座|栋|棟|幢|单元|室|号|號|楼|组团|期))*$'`,
  `${alias}.id IN (SELECT publication_source.community_id FROM cn_community_sources publication_source
    LEFT JOIN cn_ingest_candidates strict_candidate
      ON strict_candidate.provider=publication_source.provider
      AND strict_candidate.provider_poi_id=publication_source.provider_poi_id
      AND strict_candidate.decision='accepted'
      AND strict_candidate.strategy_version IN ('community-poi-v6','community-poi-v7','community-poi-v8-amap-v5','community-poi-v9-amap-compatible',
        'community-poi-v10-amap-around','community-poi-v11-amap-community','community-poi-v8-community')
    WHERE ${chinaFreshTimestampClause('publication_source.last_seen_at')}
      AND (publication_source.provider='amap' OR strict_candidate.provider IS NOT NULL
        OR publication_source.accepted_strategy_version IN ('community-poi-v6','community-poi-v7','community-poi-v8-amap-v5','community-poi-v9-amap-compatible',
        'community-poi-v10-amap-around','community-poi-v11-amap-community','community-poi-v8-community')))`
].join(' AND ');

const seedIndex = (seed: string, length: number): number => Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % length;
const seedKey = (seed: string): number => createHash('sha256').update(seed).digest().readUInt32BE(0) & 0x7fffffff;
const COMMUNITY_CANDIDATE_LIMIT = 16;
const communityRandomKey = (alias = 'community'): string => `(hashtextextended(${alias}.id, 0) & 2147483647)`;
const communityDistanceKm = (left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, value))), Math.sqrt(Math.max(0, 1 - value)));
};
const MAX_COMMUNITY_DISTANCE_KM = 25;
const COMMUNITY_VARIETY_TARGET = 16;
const providerHome: Record<string, string> = {
  amap: 'https://www.amap.com/', baidu: 'https://map.baidu.com/', tencent: 'https://map.qq.com/'
};
const providerName: Record<string, string> = { amap: '高德地图', baidu: '百度地图', tencent: '腾讯地图' };

const splitChinaDeliveryAddress = (value: string): { street: string; houseNumber: string } => {
  const match = value.match(/^(.+?)([0-9A-Za-z]+(?:(?:弄|巷)[0-9A-Za-z]+)?(?:[-之][0-9A-Za-z]+)*(?:号|號)(?:院|楼|栋|棟)?)$/u);
  if (!match) return { street: value, houseNumber: '' };
  return { street: match[1], houseNumber: match[2].replace(/號/gu, '号') };
};

const rowToAddress = (row: CommunityRow): VerifiedAddress => {
  const providerAddress = withoutTrailingCommunityName(normalizeChinaProviderAddress(row.provider_address, row), row.canonical_name);
  const delivery = splitChinaDeliveryAddress(providerAddress);
  const native: AddressComponents = {
    houseNumber: delivery.houseNumber, street: delivery.street, buildingName: row.canonical_name,
    locality: row.city, postalLocality: row.city, district: row.district,
    ...(row.township ? { dependentLocality: row.township } : {}), admin1: row.province, postcode: row.postcode || ''
  };
  const english: AddressComponents = {
    ...native,
    houseNumber: chinaEnglishPremiseNumber(delivery.houseNumber), street: chinaEnglishComponent('street', delivery.street),
    buildingName: chinaEnglishComponent('buildingName', row.canonical_name), locality: chinaEnglishComponent('locality', row.city),
    postalLocality: chinaEnglishComponent('locality', row.city), district: chinaEnglishComponent('district', row.district),
    postcode: row.postcode || '',
    ...(row.township ? { dependentLocality: chinaEnglishComponent('township', row.township) } : {}), admin1: chinaEnglishComponent('admin1', row.province)
  };
  const administration = [...new Set([row.province, row.city, row.district, row.township].filter(Boolean))].join('');
  const nativeAddress = `${administration}${providerAddress}${row.canonical_name}${row.postcode ? ` ${row.postcode}` : ''}`;
  const englishAddress = [english.buildingName, [english.houseNumber, english.street].filter(Boolean).join(' '), english.dependentLocality, english.district, english.locality, english.admin1, english.postcode, 'China']
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index).join(', ');
  const evidence: AddressEvidence[] = [...new Set(row.providers.split(',').filter(Boolean))].flatMap((provider) => {
    const sourceUrl = providerHome[provider] || '';
    const common = { sourceId: provider, sourceName: providerName[provider] || provider, sourceUrl, sourceFamily: provider, observedAt: row.last_seen_at };
    return [
      { ...common, type: 'address_existence' as const, value: nativeAddress },
      { ...common, type: 'coordinate' as const, value: `${row.latitude},${row.longitude}` },
      { ...common, type: 'residential_use' as const, value: row.canonical_name }
    ];
  });
  return {
    id: `cn-community-${row.id}`,
    countryCode: 'CN',
    nativeAddress,
    formattedAddress: englishAddress,
    nativeLanguage: 'zh-CN',
    addressVariants: { native: nativeAddress, en: englishAddress, 'zh-CN': nativeAddress },
    components: native,
    componentVariants: { native, en: english, 'zh-CN': { ...native } },
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    addressStatus: 'verified',
    propertyType: 'apartment',
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: row.verification_level,
    sourceVersion: `map-poi-${row.last_seen_at.slice(0, 10)}`,
    sourceUpdatedAt: row.last_seen_at.slice(0, 10),
    verifiedAt: row.last_seen_at,
    expiresAt: '9999-12-31T23:59:59.999Z',
    evidence,
    exclusionFlags: []
  };
};

export const countChinaCommunities = async (database?: Database): Promise<number> => {
  if (!database) return 0;
  const statement = database.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
    WHERE ${chinaCommunityPublicationClause('community')}`);
  if (typeof (statement as unknown as { first?: unknown }).first !== 'function') return 0;
  return Number(await statement.first('total') || 0);
};

export const loadChinaCommunityAddressById = async (
  database: Database | undefined,
  addressId: string
): Promise<VerifiedAddress | undefined> => {
  if (!database || !addressId.startsWith('cn-community-')) return undefined;
  const communityId = addressId.slice('cn-community-'.length).split(':')[0];
  const row = await database.prepare(`SELECT community.* FROM cn_communities_v2 community
    WHERE community.id=? AND ${chinaCommunityPublicationClause('community')}
    LIMIT 1`).bind(communityId).first<CommunityCandidateRow>();
  if (!row) return undefined;
  const providers = await loadCommunityProviders(database, row.id);
  return providers ? rowToAddress({ ...row, providers }) : undefined;
};

export const pickChinaCommunityAddress = async (
  database: Database | undefined,
  filters: AddressFilters,
  seed: string,
  coordinates?: { latitude: number; longitude: number }
): Promise<VerifiedAddress | undefined> => {
  if (!database) return undefined;
  const clauses = [chinaCommunityPublicationClause('community')];
  const bindings: unknown[] = [];
  let scopes: Array<{ clauses: string[]; bindings: unknown[] }> = [{ clauses: [], bindings: [] }];
  const aliasFilters: Array<[column: string, values: string[]]> = [];
  for (const [filter, column, suffix] of [
    ['region', 'province', '省'], ['city', 'city', '市'], ['district', 'district', '区']
  ] as const) {
    const value = filters[filter]?.trim();
    if (!value) continue;
    const stem = value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
    const values = [...new Set([value, stem, `${stem}${suffix}`])];
    if (coordinates) {
      clauses.push(`community.${column} IN (${values.map(() => '?').join(',')})`);
      bindings.push(...values);
    } else aliasFilters.push([column, values]);
  }
  // Only alias combinations some community uses get a window: each window inlines the publication clause, and
  // planning the unused ones cost more than executing the query.
  if (aliasFilters.length) {
    const columns = aliasFilters.map(([column]) => column);
    const used = (await database.prepare(`SELECT DISTINCT ${columns.join(',')} FROM cn_communities_v2
      WHERE active=1 AND ${aliasFilters.map(([column, values]) => `${column} IN (${values.map(() => '?').join(',')})`).join(' AND ')}`)
      .bind(...aliasFilters.flatMap(([, values]) => values)).all<Record<string, string>>()).results;
    if (!used.length) return undefined;
    scopes = used.map((row) => ({ clauses: columns.map((column) => `published.${column}=?`), bindings: columns.map((column) => row[column]) }));
  }
  if (filters.postcode) { clauses.push('community.postcode=?'); bindings.push(filters.postcode.replace(/\s/gu, '')); }
  if (filters.q) { clauses.push('(community.canonical_name LIKE ? OR community.provider_address LIKE ?)'); bindings.push(`%${filters.q}%`, `%${filters.q}%`); }
  // A rare character the pinyin dictionary lacks would stay Chinese in the English address, so such a community is
  // passed over rather than served half-romanized.
  const romanizable = (value: string | null | undefined): boolean =>
    !value || !/\p{Script=Han}/u.test(chinaEnglishComponent('buildingName', value));
  const allowed = (row: CommunityCandidateRow): boolean => !matchesCustomBlacklist([
    row.canonical_name, row.provider_address, row.province, row.city, row.district
  ]) && [row.canonical_name, row.provider_address, row.township, row.district].every(romanizable);
  let rows: CommunityCandidateRow[] = [];
  if (coordinates) {
    // The box widens until it holds enough communities for repeated picks to vary and is read nearest first; a fixed ±1°
    // box read every community of a metropolitan area to keep 500 by source count, which took seconds on a cold cache.
    const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
    for (const radiusKm of [0.5, 2, 8, MAX_COMMUNITY_DISTANCE_KM]) {
      const latitudeRadius = radiusKm / 111.32;
      const longitudeRadius = latitudeRadius / longitudeScale;
      const found = (await database.prepare(`SELECT community.* FROM cn_communities_v2 community
        WHERE ${clauses.join(' AND ')} AND community.latitude BETWEEN ? AND ? AND community.longitude BETWEEN ? AND ?
        ORDER BY ((community.latitude - ?) * (community.latitude - ?))
          + ((community.longitude - ?) * (community.longitude - ?) * ? * ?),community.id LIMIT 50`)
        .bind(...bindings, coordinates.latitude - latitudeRadius, coordinates.latitude + latitudeRadius,
          coordinates.longitude - longitudeRadius, coordinates.longitude + longitudeRadius,
          coordinates.latitude, coordinates.latitude, coordinates.longitude, coordinates.longitude, longitudeScale, longitudeScale)
        .all<CommunityCandidateRow>()).results || [];
      const usable = found.filter((row) => allowed(row) && communityDistanceKm(coordinates, row) <= radiusKm);
      if (usable.length) rows = usable;
      if (usable.length >= COMMUNITY_VARIETY_TARGET) break;
    }
  } else {
    const pivot = seedKey(`${seed}:china-community`);
    const randomKey = communityRandomKey('published');
      const order = `ORDER BY ${randomKey},published.id LIMIT ${COMMUNITY_CANDIDATE_LIMIT}`;
      const loadWindow = async (operator: '>=' | '<'): Promise<CommunityCandidateRow[]> => {
        const windows = scopes.map((scope) => `SELECT published.* FROM (
          SELECT community.* FROM cn_communities_v2 community WHERE ${clauses.join(' AND ')}
        ) published
          WHERE ${scope.clauses.join(' AND ') || 'TRUE'} AND ${randomKey} ${operator} ? ${order}`);
        const windowSource = windows.length === 1
          ? `(${windows[0]})`
          : `(${windows.map((window) => `(${window})`).join(' UNION ALL ')})`;
        const sql = `SELECT published.* FROM ${windowSource} published ${order}`;
      return (await database.prepare(sql).bind(
        ...scopes.flatMap((scope) => [...bindings, ...scope.bindings, pivot]))
        .all<CommunityCandidateRow>()).results;
    };
    const forward = await loadWindow('>=');
    if (forward.length >= COMMUNITY_CANDIDATE_LIMIT || typeof (database as { exec?: unknown }).exec !== 'function') rows = forward;
    else {
      const seen = new Set(forward.map(({ id }) => id));
      const wrapped = await loadWindow('<');
      rows = [...forward, ...wrapped.filter(({ id }) => !seen.has(id))].slice(0, COMMUNITY_CANDIDATE_LIMIT);
    }
  }
  if (!rows.length) return undefined;
  const allowedRows = rows.filter(allowed);
  const coordinateRows = coordinates
    ? allowedRows.map((row) => ({ row, distanceKm: communityDistanceKm(coordinates, row) }))
      .filter((candidate) => candidate.distanceKm <= MAX_COMMUNITY_DISTANCE_KM)
      .sort((left, right) => left.distanceKm - right.distanceKm)
      .map(({ row }) => row)
    : allowedRows;
  if (!coordinateRows.length) return undefined;
  // Repeated picks for one IP vary among the nearby communities instead of always returning the nearest.
  const selected = coordinateRows[seedIndex(`${seed}:candidate`, coordinateRows.length)];
  const providers = await loadCommunityProviders(database, selected.id);
  return providers ? rowToAddress({ ...selected, providers }) : undefined;
};
