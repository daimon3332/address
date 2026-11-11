import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Database, Globe2, House, Maximize2, Search, Target, X } from 'lucide-react';
import { countryByCode, isCountryCode } from '../domain/countries';
import { localeDefinitions, localizedCountryName, pathForLocale } from '../domain/locales';
import type { Locale } from '../domain/types';
import { messages } from '../domain/i18n';
import { preloadWorldMap, takeBootResponse, useMapDialogFocus, WorldCoverageMap } from './WorldCoverageMap';

interface CoverageLevel { key: string; labelEn: string; labelZh: string; covered: number; qualified: number; total: number }
export interface CoverageNode {
  key: string; countryCode: string; level: number; levelLabel: string; regionCode: string; regionName: string;
  residentialCount: number; totalCount: number; childCount: number; updatedAt: string;
  regionNameEn?: string; regionNameZh?: string; levelLabelEn?: string; levelLabelZh?: string; coverageLevels?: CoverageLevel[];
}
interface MonitorData {
  nodes: CoverageNode[];
  countries: CoverageNode[];
  metrics: { countryCount: number; addressTotal: number; residentialTotal: number; coveredLowest: number; totalLowest: number; coverageRate: number; lastUpdatedAt: string | null };
}

const text: Record<Locale, Record<string, string>> = {
  en: { valid: "Valid addresses", share: "{count} residential", brand: 'ADDRESS', monitor: 'Data monitor', generator: 'Generator', countries: 'Countries', addresses: 'Verified residences', coverage: 'Administrative coverage', distribution: 'Global address distribution', list: 'Country data', search: 'Search countries', allContinents: 'All continents', asia: 'Asia', europe: 'Europe', northAmerica: 'North America', southAmerica: 'South America', africa: 'Africa', oceania: 'Oceania', high: 'Addresses: high to low', low: 'Addresses: low to high', name: 'Country name', country: 'Country', count: 'Addresses', regions: 'Coverage', loading: 'Loading data…', retry: 'Retry', empty: 'No verified address data', all: 'All countries', close: 'Close' },
  'zh-CN': { valid: "有效地址", share: "其中住宅 {count}", brand: '地址', monitor: '数据监控', generator: '地址生成', countries: '国家数', addresses: '真实住宅总量', coverage: '行政区覆盖率', distribution: '全球地址分布', list: '国家数据列表', search: '搜索国家', allContinents: '全部大洲', asia: '亚洲', europe: '欧洲', northAmerica: '北美洲', southAmerica: '南美洲', africa: '非洲', oceania: '大洋洲', high: '地址数量：从高到低', low: '地址数量：从低到高', name: '国家名称', country: '国家', count: '地址数量', regions: '行政区覆盖', loading: '正在加载数据…', retry: '重新加载', empty: '暂无合格地址数据', all: '全部国家', close: '关闭' },
  'zh-TW': { valid: "有效地址", share: "其中住宅 {count}", brand: '地址', monitor: '資料監控', generator: '地址產生', countries: '國家數', addresses: '真實住宅總量', coverage: '行政區覆蓋率', distribution: '全球地址分佈', list: '國家資料列表', search: '搜尋國家', allContinents: '全部洲別', asia: '亞洲', europe: '歐洲', northAmerica: '北美洲', southAmerica: '南美洲', africa: '非洲', oceania: '大洋洲', high: '地址數量：由高至低', low: '地址數量：由低至高', name: '國家名稱', country: '國家', count: '地址數量', regions: '行政區覆蓋', loading: '正在載入資料…', retry: '重新載入', empty: '暫無合格地址資料', all: '全部國家', close: '關閉' },
  ja: { valid: "有効な住所", share: "うち住宅 {count}", brand: 'ADDRESS', monitor: 'データ監視', generator: '住所生成', countries: '国数', addresses: '確認済み住宅', coverage: '行政区画カバー率', distribution: '世界の住所分布', list: '国別データ', search: '国を検索', allContinents: 'すべての大陸', asia: 'アジア', europe: 'ヨーロッパ', northAmerica: '北アメリカ', southAmerica: '南アメリカ', africa: 'アフリカ', oceania: 'オセアニア', high: '住所数：多い順', low: '住所数：少ない順', name: '国名', country: '国', count: '住所数', regions: '行政区画カバー', loading: 'データを読み込み中…', retry: '再読み込み', empty: '確認済み住所データがありません', all: 'すべての国', close: '閉じる' },
  ko: { valid: "유효 주소", share: "주거 {count}", brand: 'ADDRESS', monitor: '데이터 모니터', generator: '주소 생성', countries: '국가 수', addresses: '검증된 주거지', coverage: '행정구역 범위', distribution: '전 세계 주소 분포', list: '국가 데이터', search: '국가 검색', allContinents: '모든 대륙', asia: '아시아', europe: '유럽', northAmerica: '북아메리카', southAmerica: '남아메리카', africa: '아프리카', oceania: '오세아니아', high: '주소 수: 높은 순', low: '주소 수: 낮은 순', name: '국가 이름', country: '국가', count: '주소 수', regions: '행정구역 범위', loading: '데이터 불러오는 중…', retry: '다시 시도', empty: '검증된 주소 데이터가 없습니다', all: '모든 국가', close: '닫기' },
  de: { valid: "Gültige Adressen", share: "davon {count} Wohnadressen", brand: 'ADDRESS', monitor: 'Datenmonitor', generator: 'Adressgenerator', countries: 'Länder', addresses: 'Verifizierte Wohnadressen', coverage: 'Verwaltungsabdeckung', distribution: 'Globale Adressverteilung', list: 'Länderdaten', search: 'Länder suchen', allContinents: 'Alle Kontinente', asia: 'Asien', europe: 'Europa', northAmerica: 'Nordamerika', southAmerica: 'Südamerika', africa: 'Afrika', oceania: 'Ozeanien', high: 'Adressen: absteigend', low: 'Adressen: aufsteigend', name: 'Ländername', country: 'Land', count: 'Adressen', regions: 'Verwaltungsabdeckung', loading: 'Daten werden geladen…', retry: 'Erneut laden', empty: 'Keine verifizierten Adressdaten', all: 'Alle Länder', close: 'Schließen' },
  fr: { valid: "Adresses valides", share: "dont {count} résidentielles", brand: 'ADDRESS', monitor: 'Suivi des données', generator: "Générateur d'adresses", countries: 'Pays', addresses: 'Résidences vérifiées', coverage: 'Couverture administrative', distribution: 'Répartition mondiale des adresses', list: 'Données par pays', search: 'Rechercher un pays', allContinents: 'Tous les continents', asia: 'Asie', europe: 'Europe', northAmerica: 'Amérique du Nord', southAmerica: 'Amérique du Sud', africa: 'Afrique', oceania: 'Océanie', high: 'Adresses : décroissant', low: 'Adresses : croissant', name: 'Nom du pays', country: 'Pays', count: 'Adresses', regions: 'Couverture administrative', loading: 'Chargement des données…', retry: 'Réessayer', empty: "Aucune donnée d'adresse vérifiée", all: 'Tous les pays', close: 'Fermer' },
  es: { valid: "Direcciones válidas", share: "{count} residenciales", brand: 'ADDRESS', monitor: 'Monitor de datos', generator: 'Generador de direcciones', countries: 'Países', addresses: 'Residencias verificadas', coverage: 'Cobertura administrativa', distribution: 'Distribución mundial de direcciones', list: 'Datos por país', search: 'Buscar países', allContinents: 'Todos los continentes', asia: 'Asia', europe: 'Europa', northAmerica: 'Norteamérica', southAmerica: 'Sudamérica', africa: 'África', oceania: 'Oceanía', high: 'Direcciones: descendente', low: 'Direcciones: ascendente', name: 'Nombre del país', country: 'País', count: 'Direcciones', regions: 'Cobertura administrativa', loading: 'Cargando datos…', retry: 'Reintentar', empty: 'No hay datos de direcciones verificadas', all: 'Todos los países', close: 'Cerrar' },
  pt: { valid: "Endereços válidos", share: "{count} residenciais", brand: 'ADDRESS', monitor: 'Monitor de dados', generator: 'Gerador de endereços', countries: 'Países', addresses: 'Residências verificadas', coverage: 'Cobertura administrativa', distribution: 'Distribuição global de endereços', list: 'Dados por país', search: 'Pesquisar países', allContinents: 'Todos os continentes', asia: 'Ásia', europe: 'Europa', northAmerica: 'América do Norte', southAmerica: 'América do Sul', africa: 'África', oceania: 'Oceania', high: 'Endereços: decrescente', low: 'Endereços: crescente', name: 'Nome do país', country: 'País', count: 'Endereços', regions: 'Cobertura administrativa', loading: 'Carregando dados…', retry: 'Tentar novamente', empty: 'Sem dados de endereços verificados', all: 'Todos os países', close: 'Fechar' }
};

type Continent = 'all' | 'asia' | 'europe' | 'northAmerica' | 'southAmerica' | 'africa' | 'oceania';
const continentByGroup: Record<string, Exclude<Continent, 'all'>> = {
  'east-asia': 'asia', 'southeast-asia': 'asia', 'south-asia': 'asia', 'middle-east': 'asia', europe: 'europe',
  'north-america': 'northAmerica', 'south-america': 'southAmerica', africa: 'africa', oceania: 'oceania'
};

const regionName = (node: CoverageNode, locale: Locale): string => {
  if (node.level === 0 && isCountryCode(node.countryCode)) {
    return localizedCountryName(node.countryCode, locale, countryByCode.get(node.countryCode)?.name.en || node.regionName);
  }
  if (locale === 'zh-CN' || locale === 'zh-TW') return node.regionNameZh || node.regionName;
  return node.regionNameEn || node.regionName;
};

const coverage = (node: CoverageNode): string => {
  const levels = node.coverageLevels || [];
  const covered = levels.reduce((sum, level) => sum + level.covered, 0);
  const total = levels.reduce((sum, level) => sum + level.total, 0);
  return total ? `${covered.toLocaleString()} / ${total.toLocaleString()}` : '-';
};

export const nextMonitorTrail = (trail: CoverageNode[], node: CoverageNode): CoverageNode[] => {
  if (node.level === 0) return [node];
  return [...trail.filter((item) => item.countryCode === node.countryCode && item.level < node.level), node];
};

function MapSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.appendChild(host); }, [host]);
  return <div ref={ref} style={{ display: 'contents' }} />;
}

export default function PublicMonitor({ locale }: { locale: Locale }) {
  const t = text[locale];
  const [data, setData] = useState<MonitorData>();
  const [trail, setTrail] = useState<CoverageNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const [continent, setContinent] = useState<Continent>('all');
  const [sort, setSort] = useState<'high' | 'low' | 'name'>('high');
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useMapDialogFocus(expanded, () => setExpanded(false));
  const [mapHost] = useState(() => {
    if (typeof document === 'undefined') return undefined;
    const host = document.createElement('div');
    host.style.display = 'contents';
    return host;
  });
  const loadId = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const trailRef = useRef<CoverageNode[]>([]);
  const parentRef = useRef('');

  const load = async (parent = '') => {
    const id = ++loadId.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(false);
    try {
      const response = !parent && await takeBootResponse('__monitorBoot', 'data')
        || await fetch(`/web-api/v1/public-monitor${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        });
      if (id !== loadId.current) return;
      if (response.status === 401) {
        window.location.assign(`/${locale}/access/?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (!response.ok) throw new Error('MONITOR_UNAVAILABLE');
      const payload = await response.json() as { data: MonitorData };
      if (id === loadId.current) setData(payload.data);
    } catch { if (id === loadId.current) { setError(true); setExpanded(false); } }
    finally { if (id === loadId.current) setLoading(false); }
  };

  useEffect(() => { preloadWorldMap(); void load(); return () => { loadId.current += 1; request.current?.abort(); }; }, []);
  const open = (node: CoverageNode) => {
    if (!node.childCount) return;
    if (parentRef.current === node.key) return;
    const next = nextMonitorTrail(trailRef.current, node);
    trailRef.current = next;
    parentRef.current = node.key;
    setTrail(next);
    void load(node.key);
  };
  const backTo = (index: number) => {
    const next = index < 0 ? [] : trailRef.current.slice(0, index + 1);
    const parent = next.at(-1)?.key || '';
    if (parentRef.current === parent) return;
    trailRef.current = next;
    parentRef.current = parent;
    setTrail(next);
    void load(parent);
  };
  const selectedCountry = trail[0];
  const root = trail.length === 0;
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return [...(data?.nodes || [])].filter((node) => {
      if (!root) return true;
      const meta = isCountryCode(node.countryCode) ? countryByCode.get(node.countryCode) : undefined;
      if (continent !== 'all' && (!meta || continentByGroup[meta.group] !== continent)) return false;
      return !query || [node.countryCode, regionName(node, locale)].some((value) => value.toLocaleLowerCase().includes(query));
    }).sort((left, right) => sort === 'low' ? left.residentialCount - right.residentialCount
      : sort === 'name' ? regionName(left, locale).localeCompare(regionName(right, locale), locale)
        : right.residentialCount - left.residentialCount);
  }, [continent, data?.nodes, locale, root, search, sort]);

  return <div className="monitor-page">
    <header className="monitor-topbar">
      <a className="monitor-brand" href={`/${locale}/`}><Database size={20} /><strong>{t.brand}</strong><span>{t.monitor}</span></a>
      <nav><a href={`/${locale}/`}><ArrowLeft size={15} />{t.generator}</a><select aria-label="Language" value={locale} onChange={(event) => window.location.assign(pathForLocale(window.location.pathname, event.target.value as Locale))}>{localeDefinitions.map((definition) => <option key={definition.code} value={definition.code}>{definition.label}</option>)}</select></nav>
    </header>
    <main className="monitor-content">
      {loading && !data ? <div className="monitor-state">{t.loading}</div> : error || !data ? <div className="monitor-state"><span>{t.empty}</span><button onClick={() => void load(trail.at(-1)?.key)}>{t.retry}</button></div> : <>
        {root && <section className="dashboard-kpis monitor-kpis">
          <article className="dashboard-kpi"><span className="dashboard-kpi-icon blue"><Globe2 size={20} /></span><div><small>{t.countries}</small><strong>{data.metrics.countryCount.toLocaleString()}</strong></div></article>
          <article className="dashboard-kpi"><span className="dashboard-kpi-icon green"><House size={20} /></span><div><small>{t.valid}</small><strong>{data.metrics.addressTotal.toLocaleString()}</strong><em>{t.share.replace('{count}', data.metrics.residentialTotal.toLocaleString())}</em></div></article>
          <article className="dashboard-kpi"><span className="dashboard-kpi-icon amber"><Target size={20} /></span><div><small>{t.coverage}</small><strong>{(data.metrics.coverageRate * 100).toFixed(1)}%</strong></div></article>
        </section>}
        <div className="coverage-breadcrumb dashboard-breadcrumb"><button onClick={() => backTo(-1)}>{t.all}</button>{trail.map((node, index) => <span key={node.key}>/<button onClick={() => backTo(index)}>{regionName(node, locale)}</button></span>)}</div>
        <section className="dashboard-card map-card"><header><h2>{selectedCountry ? regionName(selectedCountry, locale) : t.distribution}</h2><button type="button" className="map-expand-button" aria-label={t.distribution} onClick={() => setExpanded(true)}><Maximize2 size={17} /></button></header>{mapHost && !expanded && <MapSlot host={mapHost} />}</section>
        <section className="dashboard-card country-data-table monitor-table"><header><h2>{root ? t.list : regionName(trail.at(-1)!, locale)}</h2>{root && <div className="country-table-tools"><label className="country-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.search} /></label><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="high">{t.high}</option><option value="low">{t.low}</option><option value="name">{t.name}</option></select><select value={continent} onChange={(event) => setContinent(event.target.value as Continent)}><option value="all">{t.allContinents}</option>{(['asia', 'europe', 'northAmerica', 'southAmerica', 'africa', 'oceania'] as const).map((value) => <option key={value} value={value}>{t[value]}</option>)}</select></div>}</header>
          <div className="table-scroll"><table><thead><tr><th>{root ? t.country : t.name}</th><th>{t.addresses}</th><th>{t.regions}</th></tr></thead><tbody>{visible.map((node) => <tr key={node.key}><td><button className="monitor-region-button" disabled={!node.childCount} onClick={() => open(node)}>{regionName(node, locale)}</button></td><td className="numeric-cell">{node.residentialCount.toLocaleString()}</td><td>{coverage(node)}</td></tr>)}</tbody></table>{!visible.length && <div className="empty-table">{t.empty}</div>}</div>
        </section>
        {expanded && <div className="map-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setExpanded(false); }}><section ref={dialogRef} tabIndex={-1} className="map-dialog" role="dialog" aria-modal="true" aria-label={t.distribution}><header><h2>{t.distribution}</h2><button className="icon-button" aria-label={t.close} onClick={() => setExpanded(false)}><X size={18} /></button></header>{mapHost && <MapSlot host={mapHost} />}</section></div>}
        {mapHost && createPortal(<WorldCoverageMap countries={data.countries} selected={selectedCountry} label={(node) => regionName(node, locale)} ariaLabel={t.distribution} onSelect={open} onBack={() => backTo(-1)} expanded={expanded} mapText={{ loading: t.loading, error: messages[locale].mapLoadFailed, retry: t.retry }} />, mapHost)}
      </>}
    </main>
  </div>;
}
