import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe2, Minus, Plus, RotateCcw } from 'lucide-react';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLatBoundsLike,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapMouseEvent,
  Popup,
  StyleSpecification
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

export interface WorldCoverageCountry {
  countryCode: string;
  residentialCount: number;
  childCount: number;
}

interface WorldCoverageMapProps<T extends WorldCoverageCountry> {
  countries: T[];
  selected?: T;
  label: (country: T) => string;
  ariaLabel: string;
  onSelect: (country: T) => void;
  onBack?: () => void;
  expanded?: boolean;
  mapText?: { loading: string; error: string; retry: string };
}

export const useMapDialogFocus = (open: boolean, close: () => void) => {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...root.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    ) || []].filter((element) => element.getClientRects().length > 0);
    (focusable()[0] || root.current)?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const values = focusable();
      if (!values.length) { event.preventDefault(); root.current?.focus(); return; }
      const first = values[0]; const last = values[values.length - 1];
      if (!root.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  return root;
};

type GeoJsonGeometry = {
  type: string;
  coordinates: unknown;
};

type GeoJsonFeature = {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: GeoJsonGeometry;
};

type GeoJsonCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

type MapLibre = typeof import('maplibre-gl');
let maplibrePromise: Promise<MapLibre> | undefined;
const loadMapLibre = (): Promise<MapLibre> => {
  maplibrePromise ||= import('maplibre-gl').then((module) => {
    module.setWorkerUrl(workerUrl);
    return module;
  }).catch((error) => { maplibrePromise = undefined; throw error; });
  return maplibrePromise;
};

const sourceUrl = '/maps/world-map-units.geojson';
const admin1Url = (code: string) => `/maps/admin-1/${code}.geojson`;
const admin2Url = (code: string) => `/maps/admin-2/${code}.geojson`;
// County-level outlines and their hover names appear once a selected country is zoomed this far.
const ADMIN2_MIN_ZOOM = 3.2;
// Countries with a file in public/maps/admin-2; Overture has no second-order units for the others.
const admin2Countries = new Set(['AU', 'BR', 'CA', 'CN', 'DE', 'ES', 'FR', 'GB', 'IN', 'IT', 'JP', 'KR', 'MX', 'MY', 'NG', 'NL',
  'PH', 'RU', 'SA', 'SG', 'TH', 'TR', 'US', 'ZA']);
const worldBounds: LngLatBoundsLike = [[-179.999999, -85], [179.999999, 85]];
const fallbackLabelCoordinates: Record<string, [number, number]> = { HK: [114.17, 22.32], SG: [103.82, 1.35] };
let sourcePromise: Promise<GeoJsonCollection> | undefined;
const admin1Promises = new Map<string, Promise<GeoJsonCollection | undefined>>();

// A page's inline script may already have started a request, with the same timeout as the request it replaces;
// each is adopted once and fails like that request would.
export const takeBootResponse = (store: string, key: string): Promise<Response> | undefined => {
  const boot = (globalThis as Record<string, unknown>)[store] as Record<string, Promise<Response> | undefined> | undefined;
  const value = boot?.[key];
  if (boot) delete boot[key];
  return value;
};

const loadWorldSource = (): Promise<GeoJsonCollection> => {
  sourcePromise ||= (async () => await takeBootResponse('__monitorBoot', 'map')
    || fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) }))().then(async (response) => {
    if (!response.ok) throw new Error(`WORLD_MAP_${response.status}`);
    return await response.json() as GeoJsonCollection;
  }).catch((error) => { sourcePromise = undefined; throw error; });
  return sourcePromise;
};

// The map library and the world outline do not depend on the figures, so callers start them alongside their data.
export const preloadWorldMap = (): void => {
  void loadMapLibre().catch(() => undefined);
  void loadWorldSource().catch(() => undefined);
};

const loadAdmin1Source = (code: string, url = admin1Url): Promise<GeoJsonCollection | undefined> => {
  const normalized = `${url === admin1Url ? '' : '2:'}${code.toUpperCase()}`;
  let request = admin1Promises.get(normalized);
  if (!request) {
    request = fetch(url(code.toUpperCase()), { signal: AbortSignal.timeout(15_000) }).then(async (response) => {
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`ADMIN1_MAP_${response.status}`);
      const value = await response.json() as GeoJsonCollection;
      return value.type === 'FeatureCollection' && value.features.length ? value : undefined;
    }).catch(() => {
      admin1Promises.delete(normalized);
      return undefined;
    });
    admin1Promises.set(normalized, request);
  }
  return request;
};

const featureCode = (feature: GeoJsonFeature): string => {
  const properties = feature.properties;
  const candidates = [properties.ISO_A2, properties.ISO_A2_EH, properties.WB_A2];
  return String(candidates.find((value) => typeof value === 'string' && /^[A-Z]{2}$/u.test(value)) || '').toUpperCase();
};

const visitCoordinates = (value: unknown, visit: (longitude: number, latitude: number) => void): void => {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    visit(value[0], value[1]);
    return;
  }
  value.forEach((entry) => visitCoordinates(entry, visit));
};

export const shortestLongitudeInterval = (longitudes: number[]): [number, number] | undefined => {
  const values = longitudes
    .filter(Number.isFinite)
    .map((longitude) => ((longitude % 360) + 360) % 360)
    .sort((left, right) => left - right);
  if (!values.length) return undefined;
  if (values.length === 1) {
    const longitude = values[0] > 180 ? values[0] - 360 : values[0];
    return [longitude, longitude];
  }

  let largestGap = -1;
  let intervalStart = values[0];
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    const next = index === values.length - 1 ? values[0] + 360 : values[index + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      intervalStart = next % 360;
    }
  }

  const west = intervalStart > 180 ? intervalStart - 360 : intervalStart;
  return [west, west + 360 - largestGap];
};

const featureBounds = (feature: GeoJsonFeature): [[number, number], [number, number]] | undefined => {
  const longitudes: number[] = [];
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  visitCoordinates(feature.geometry.coordinates, (longitude, latitude) => {
    longitudes.push(longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  });
  const longitudeInterval = shortestLongitudeInterval(longitudes);
  return longitudeInterval
    ? [[longitudeInterval[0], south], [longitudeInterval[1], north]]
    : undefined;
};

const labelImage = (code: string): ImageData => {
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = 34 * scale;
  canvas.height = 24 * scale;
  const context = canvas.getContext('2d');
  if (!context) return new ImageData(canvas.width, canvas.height);
  context.scale(scale, scale);
  context.fillStyle = 'rgba(255, 255, 255, .94)';
  context.strokeStyle = 'rgba(103, 119, 142, .28)';
  context.lineWidth = .75;
  context.beginPath();
  context.roundRect(1, 1, 32, 22, 5);
  context.fill();
  context.stroke();
  context.fillStyle = '#26364d';
  context.font = '700 11px Segoe UI, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(code, 17, 12.5);
  return context.getImageData(0, 0, canvas.width, canvas.height);
};

const traditionalHanMarkers = /[區維爾內肅雲龍遼寧廣東蘇慶貴陝]/u;

const admin1DisplayName = (properties: Record<string, unknown>): string => {
  const variants = String(properties.native_name || '').split('|').map((value) => value.trim()).filter(Boolean);
  const preferred = variants.find((variant) => !traditionalHanMarkers.test(variant)) || variants[0];
  return preferred || String(properties.name || '').trim();
};

const admin1LabelFont = '600 10px Segoe UI, Arial, sans-serif';

const admin1LabelImage = (name: string): ImageData => {
  const scale = 2;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  if (!measure) return new ImageData(2, 2);
  measure.font = admin1LabelFont;
  const width = Math.min(Math.ceil(measure.measureText(name).width) + 12, 168);
  canvas.width = width * scale;
  canvas.height = 18 * scale;
  const context = canvas.getContext('2d');
  if (!context) return new ImageData(canvas.width, canvas.height);
  context.scale(scale, scale);
  context.fillStyle = 'rgba(255, 255, 255, .88)';
  context.strokeStyle = 'rgba(103, 119, 142, .3)';
  context.lineWidth = .6;
  context.beginPath();
  context.roundRect(.5, .5, width - 1, 17, 4);
  context.fill();
  context.stroke();
  context.fillStyle = '#33445c';
  context.font = admin1LabelFont;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(name, width / 2, 9.5, width - 8);
  return context.getImageData(0, 0, canvas.width, canvas.height);
};

const mapStyle: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef4f9' } }]
};

const fillColor: ExpressionSpecification = [
  'case',
  ['==', ['get', 'address_count'], 0], '#dfe6ee',
  ['interpolate', ['linear'], ['get', 'address_count'],
    1, '#d8e7fa',
    1_000, '#b4d0f5',
    10_000, '#80acec',
    100_000, '#4b8fe8',
    500_000, '#1769e0']
];

const ambientAdmin1Opacity: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 1.8, 0, 2.8, .58];

const buildSources = <T extends WorldCoverageCountry>(source: GeoJsonCollection, countries: T[]) => {
  const byCode = new Map(countries.map((country) => [country.countryCode.toUpperCase(), country]));
  const features: GeoJsonFeature[] = source.features.map((feature) => {
    const code = featureCode(feature);
    const country = byCode.get(code);
    return {
      ...feature,
      properties: {
        ...feature.properties,
        country_code: code,
        address_count: country?.residentialCount || 0,
        interactive: Boolean(country?.childCount)
      }
    };
  });
  const labelPoints: GeoJsonFeature[] = features.flatMap((feature) => {
    const code = String(feature.properties.country_code || '');
    const country = byCode.get(code);
    const longitude = Number(feature.properties.LABEL_X);
    const latitude = Number(feature.properties.LABEL_Y);
    if (!country || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
    return [{
      type: 'Feature' as const,
      properties: { country_code: code, icon: `country-label-${code}`, address_count: country.residentialCount },
      geometry: { type: 'Point', coordinates: [longitude, latitude] }
    }];
  });
  const represented = new Set(labelPoints.map((feature) => String(feature.properties.country_code)));
  for (const [code, country] of byCode) {
    const coordinates = fallbackLabelCoordinates[code];
    if (represented.has(code) || !coordinates) continue;
    labelPoints.push({
      type: 'Feature',
      properties: { country_code: code, icon: `country-label-${code}`, address_count: country.residentialCount },
      geometry: { type: 'Point', coordinates }
    });
  }
  return {
    polygons: { type: 'FeatureCollection' as const, features },
    labels: { type: 'FeatureCollection' as const, features: labelPoints },
    byCode,
    featureByCode: new Map(features.map((feature) => [String(feature.properties.country_code), feature]))
  };
};

export function WorldCoverageMap<T extends WorldCoverageCountry>({
  countries, selected, label, ariaLabel, onSelect, onBack, expanded = false,
  mapText = { loading: 'Loading map…', error: 'The map could not load. You can still use the data list.', retry: 'Retry' }
}: WorldCoverageMapProps<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | undefined>(undefined);
  const sourceRef = useRef<GeoJsonCollection | undefined>(undefined);
  const loadAdmin1Ref = useRef<(code: string) => Promise<void>>(async () => undefined);
  const syncAdmin1Ref = useRef<() => void>(() => undefined);
  const admin1CodesRef = useRef(new Set<string>());
  const countriesRef = useRef(countries);
  const selectedRef = useRef(selected);
  const labelRef = useRef(label);
  const selectRef = useRef(onSelect);
  const backRef = useRef(onBack);
  const expandedRef = useRef(expanded);

  countriesRef.current = countries;
  selectedRef.current = selected;
  labelRef.current = label;
  selectRef.current = onSelect;
  backRef.current = onBack;
  expandedRef.current = expanded;

  const countrySignature = useMemo(
    () => countries.map((country) => `${country.countryCode}:${country.residentialCount}:${country.childCount}`).join('|'),
    [countries]
  );

  useEffect(() => {
    if (!containerRef.current) return;
    let active = true;
    let map: MapLibreMap | undefined;
    let observer: ResizeObserver | undefined;
    let initialized = false;
    setState('loading'); sourceRef.current = undefined;
    const fail = () => { if (active) setState('error'); };
    const timeout = window.setTimeout(() => { if (!initialized) fail(); }, 15_000);

    const initialize = async (map: MapLibreMap, maplibre: MapLibre) => {
      const source = await loadWorldSource();
      if (!active) return;
      sourceRef.current = source;
      const values = buildSources(source, countriesRef.current);
      map.addSource('countries', { type: 'geojson', data: values.polygons });
      map.addSource('country-labels', { type: 'geojson', data: values.labels });
      map.addLayer({ id: 'country-fill', type: 'fill', source: 'countries', paint: { 'fill-color': fillColor, 'fill-opacity': .96 } });
      map.addLayer({ id: 'country-border', type: 'line', source: 'countries', paint: { 'line-color': '#9eabba', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, .5, 4, 1.15], 'line-opacity': .95 } });
      countriesRef.current.forEach((country) => {
        const code = country.countryCode.toUpperCase();
        if (!map.hasImage(`country-label-${code}`)) map.addImage(`country-label-${code}`, labelImage(code), { pixelRatio: 2 });
      });
      map.addLayer({
        id: 'country-labels', type: 'symbol', source: 'country-labels', minzoom: .5,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], .5, .78, 2, .95, 4, 1.05],
          'icon-allow-overlap': false,
          'icon-ignore-placement': false,
          'symbol-sort-key': ['-', ['get', 'address_count']]
        }
      });
      const popup: Popup = new maplibre.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'coverage-map-popup' });
      const syncAdmin1 = () => {
        const selectedCode = selectedRef.current?.countryCode.toUpperCase();
        for (const code of admin1CodesRef.current) {
          const border = `admin-1-border-${code}`;
          if (map.getLayer(border)) {
            map.setPaintProperty(border, 'line-opacity', selectedCode === code ? .82 : selectedCode ? 0 : ambientAdmin1Opacity);
          }
          for (const layer of [`admin-1-fill-${code}`, `admin-1-label-${code}`, `admin-2-fill-${code}`, `admin-2-border-${code}`]) {
            if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', selectedCode === code ? 'visible' : 'none');
          }
        }
      };
      syncAdmin1Ref.current = syncAdmin1;
      const ensureAdmin1 = async (code: string) => {
        const normalized = code.toUpperCase();
        const sourceId = `admin-1-${normalized}`;
        if (!active || map.getSource(sourceId)) return;
        const data = await loadAdmin1Source(normalized);
        if (!active || !data || map.getSource(sourceId)) return;
        map.addSource(sourceId, { type: 'geojson', data, promoteId: 'region_code' });
        const labelFeatures: GeoJsonFeature[] = data.features.flatMap((feature) => {
          const regionCode = String(feature.properties.region_code || '');
          const name = admin1DisplayName(feature.properties);
          const bounds = featureBounds(feature);
          if (!regionCode || !name || !bounds) return [];
          const icon = `admin1-label-${regionCode}`;
          if (!map.hasImage(icon)) map.addImage(icon, admin1LabelImage(name), { pixelRatio: 2 });
          return [{
            type: 'Feature' as const,
            properties: { icon },
            geometry: { type: 'Point', coordinates: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2] }
          }];
        });
        map.addSource(`${sourceId}-labels`, { type: 'geojson', data: { type: 'FeatureCollection', features: labelFeatures } });
        map.addLayer({
          id: `admin-1-fill-${normalized}`,
          type: 'fill',
          source: sourceId,
          layout: { visibility: 'none' },
          paint: {
            'fill-color': '#1769e0',
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], .14, 0]
          }
        }, 'country-labels');
        map.addLayer({
          id: `admin-1-border-${normalized}`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': '#657991',
            'line-width': ['interpolate', ['linear'], ['zoom'], 1, .45, 3, .85, 6, 1.25],
            'line-opacity': ambientAdmin1Opacity
          }
        }, 'country-labels');
        map.addLayer({
          id: `admin-1-label-${normalized}`,
          type: 'symbol',
          source: `${sourceId}-labels`,
          minzoom: 2,
          layout: {
            visibility: 'none',
            'icon-image': ['get', 'icon'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 2, .8, 5, 1],
            'icon-allow-overlap': false
          }
        }, 'country-labels');
        let hovered: string | number | undefined;
        const clearHover = () => {
          if (hovered !== undefined) map.setFeatureState({ source: sourceId, id: hovered }, { hover: false });
          hovered = undefined;
        };
        map.on('mousemove', `admin-1-fill-${normalized}`, (event: MapLayerMouseEvent) => {
          if (selectedRef.current?.countryCode.toUpperCase() !== normalized) return;
          // Zoomed in, the county under the pointer is named instead.
          if (map.getLayer(`admin-2-fill-${normalized}`) && map.getZoom() >= ADMIN2_MIN_ZOOM) { clearHover(); return; }
          const feature = event.features?.[0];
          if (!feature) return;
          if (feature.id !== undefined && feature.id !== hovered) {
            clearHover();
            hovered = feature.id;
            map.setFeatureState({ source: sourceId, id: feature.id }, { hover: true });
          }
          const native = admin1DisplayName(feature.properties || {});
          const english = String(feature.properties?.name || '').trim();
          const content = document.createElement('strong');
          content.textContent = native && english && native !== english ? `${native} · ${english}` : native || english;
          if (content.textContent) popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        });
        map.on('mouseleave', `admin-1-fill-${normalized}`, () => { clearHover(); popup.remove(); });
        admin1CodesRef.current.add(normalized);
        syncAdmin1();
      };
      // Second-order outlines load for the selected country only, after its first-order layers.
      const ensureAdmin2 = async (code: string) => {
        const normalized = code.toUpperCase();
        const sourceId = `admin-2-${normalized}`;
        if (!active || !admin2Countries.has(normalized) || map.getSource(sourceId)) return;
        const data = await loadAdmin1Source(normalized, admin2Url);
        if (!active || !data || map.getSource(sourceId)) return;
        map.addSource(sourceId, { type: 'geojson', data, generateId: true });
        const before = map.getLayer(`admin-1-border-${normalized}`) ? `admin-1-border-${normalized}` : 'country-labels';
        map.addLayer({
          id: `admin-2-fill-${normalized}`, type: 'fill', source: sourceId, minzoom: ADMIN2_MIN_ZOOM,
          layout: { visibility: 'none' },
          paint: { 'fill-color': '#1769e0', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], .16, 0] }
        }, before);
        map.addLayer({
          id: `admin-2-border-${normalized}`, type: 'line', source: sourceId, minzoom: ADMIN2_MIN_ZOOM,
          layout: { visibility: 'none' },
          paint: {
            'line-color': '#ffffff',
            'line-width': ['interpolate', ['linear'], ['zoom'], ADMIN2_MIN_ZOOM, .3, 6, .6, 9, 1],
            'line-opacity': .6
          }
        }, before);
        let hovered: string | number | undefined;
        const clearHover = () => {
          if (hovered !== undefined) map.setFeatureState({ source: sourceId, id: hovered }, { hover: false });
          hovered = undefined;
        };
        map.on('mousemove', `admin-2-fill-${normalized}`, (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0];
          if (!feature) return;
          if (feature.id !== undefined && feature.id !== hovered) {
            clearHover();
            hovered = feature.id;
            map.setFeatureState({ source: sourceId, id: feature.id }, { hover: true });
          }
          const native = String(feature.properties?.native_name || '').trim();
          const english = String(feature.properties?.name || '').trim();
          const content = document.createElement('strong');
          content.textContent = native && english && native !== english ? `${native} · ${english}` : native || english;
          if (content.textContent) popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
        });
        map.on('mouseleave', `admin-2-fill-${normalized}`, () => { clearHover(); popup.remove(); });
        syncAdmin1();
      };
      loadAdmin1Ref.current = async (code: string) => { await ensureAdmin1(code); await ensureAdmin2(code); };
      const loadVisibleAdmin1 = () => {
        syncAdmin1();
        const selectedCode = selectedRef.current?.countryCode.toUpperCase();
        if (selectedCode) {
          void loadAdmin1Ref.current(selectedCode);
          return;
        }
        if (map.getZoom() < 2.8) return;
        const codes = new Set(map.queryRenderedFeatures(undefined, { layers: ['country-fill'] })
          .map((feature) => String(feature.properties?.country_code || ''))
          .filter((code) => /^[A-Z]{2}$/u.test(code)));
        [...codes].slice(0, 8).forEach((code) => { void ensureAdmin1(code); });
      };
      map.on('moveend', loadVisibleAdmin1);
      const initialSelected = selectedRef.current;
      const initialFeature = initialSelected && values.featureByCode.get(initialSelected.countryCode.toUpperCase());
      const initialBounds = initialFeature && featureBounds(initialFeature);
      if (initialBounds) map.fitBounds(initialBounds, { padding: expandedRef.current ? 90 : 54, maxZoom: 6, duration: 0 });
      loadVisibleAdmin1();
      const onMove = (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        const code = String(feature?.properties?.country_code || '');
        const country = countriesRef.current.find((entry) => entry.countryCode.toUpperCase() === code);
        map.getCanvas().style.cursor = country?.childCount ? 'pointer' : '';
        if (!country) { popup.remove(); return; }
        if (selectedRef.current?.countryCode.toUpperCase() === code) { popup.remove(); return; }
        const content = document.createElement('div');
        const name = document.createElement('strong');
        const count = document.createElement('span');
        name.textContent = labelRef.current(country);
        count.textContent = country.residentialCount.toLocaleString();
        content.append(name, count);
        popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
      };
      const onLeave = () => { map.getCanvas().style.cursor = ''; popup.remove(); };
      const onClick = (event: MapLayerMouseEvent) => {
        const code = String(event.features?.[0]?.properties?.country_code || '');
        const country = countriesRef.current.find((entry) => entry.countryCode.toUpperCase() === code);
        if (!country?.childCount || selectedRef.current?.countryCode.toUpperCase() === code) return;
        selectedRef.current = country;
        selectRef.current(country);
      };
      map.on('mousemove', 'country-fill', onMove);
      map.on('mousemove', 'country-labels', onMove);
      map.on('mouseleave', 'country-fill', onLeave);
      map.on('mouseleave', 'country-labels', onLeave);
      map.on('click', 'country-fill', onClick);
      map.on('click', 'country-labels', onClick);
      map.on('click', (event: MapMouseEvent) => {
        if (!selectedRef.current || !backRef.current || !map.getLayer('country-fill')) return;
        if (!map.queryRenderedFeatures(event.point, { layers: ['country-fill'] }).length) backRef.current();
      });
    };

    const setup = async () => {
      const maplibre = await loadMapLibre();
      if (!active || !containerRef.current) return;
      const created = new maplibre.Map({
        container: containerRef.current,
        style: mapStyle,
        center: [105, 18],
        zoom: expandedRef.current ? 1.35 : 1.05,
        minZoom: .65,
        maxZoom: 7.5,
        cooperativeGestures: true,
        renderWorldCopies: false,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        maxPitch: 0
      });
      map = created;
      // The county outlines derive from OpenStreetMap through Overture Maps, which asks for visible credit.
      created.addControl(new maplibre.AttributionControl({
        compact: true, customAttribution: '© OpenStreetMap contributors, Overture Maps Foundation · Natural Earth'
      }), 'top-left');
      mapRef.current = created;
      observer = new ResizeObserver(() => created.resize());
      observer.observe(containerRef.current);
      created.once('load', () => {
        created.setMaxBounds(worldBounds);
        void initialize(created, maplibre).then(() => {
          if (!active) return;
          const ready = () => { if (active) { initialized = true; window.clearTimeout(timeout); setState('ready'); } };
          if (created.loaded()) ready(); else created.once('idle', ready);
        }).catch(fail);
      });
      created.on('error', fail);
    };
    void setup().catch(fail);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      observer?.disconnect();
      loadAdmin1Ref.current = async () => undefined;
      syncAdmin1Ref.current = () => undefined;
      admin1CodesRef.current.clear();
      map?.remove();
      mapRef.current = undefined;
    };
  }, [attempt]);

  useEffect(() => {
    const map = mapRef.current;
    const source = sourceRef.current;
    if (!map || !source || !map.isStyleLoaded()) return;
    const values = buildSources(source, countries);
    (map.getSource('countries') as GeoJSONSource | undefined)?.setData(values.polygons);
    (map.getSource('country-labels') as GeoJSONSource | undefined)?.setData(values.labels);
    countries.forEach((country) => {
      const code = country.countryCode.toUpperCase();
      if (!map.hasImage(`country-label-${code}`)) map.addImage(`country-label-${code}`, labelImage(code), { pixelRatio: 2 });
    });
  }, [countries, countrySignature]);

  useEffect(() => {
    const map = mapRef.current;
    const source = sourceRef.current;
    if (!map || !source) return;
    syncAdmin1Ref.current();
    if (!selected) {
      map.easeTo({ center: [105, 18], zoom: expanded ? 1.35 : 1.05, duration: 550 });
      return;
    }
    void loadAdmin1Ref.current(selected.countryCode);
    const feature = buildSources(source, countries).featureByCode.get(selected.countryCode.toUpperCase());
    const bounds = feature && featureBounds(feature);
    if (bounds) map.fitBounds(bounds, { padding: expanded ? 90 : 54, maxZoom: 6, duration: 650 });
  }, [countries, expanded, selected]);

  return <div className={`world-map-layout${expanded ? ' expanded' : ''}`} aria-label={ariaLabel} data-map-state={state}>
    <div ref={containerRef} className="world-distribution-map" />
    {state !== 'ready' && <div className="world-map-state" role={state === 'error' ? 'alert' : 'status'}>
      <span>{state === 'error' ? mapText.error : mapText.loading}</span>
      {state === 'error' && <button type="button" onClick={() => setAttempt((value) => value + 1)}>{mapText.retry}</button>}
    </div>}
    <div className="map-legend" aria-hidden="true">
      {['500K+', '100K', '10K', '1K', '1+', '0'].map((value, index) => <span key={value}><i className={`scale-${index}`} />{value}</span>)}
    </div>
    <div className="map-zoom-controls">
      {selected && onBack && <button type="button" aria-label="Back to world view" onClick={onBack}><Globe2 size={14} /></button>}
      <button type="button" disabled={state !== 'ready'} aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Plus size={15} /></button>
      <button type="button" disabled={state !== 'ready'} aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Minus size={15} /></button>
      <button type="button" disabled={state !== 'ready'} aria-label="Reset map" onClick={() => mapRef.current?.easeTo({ center: [105, 18], zoom: expanded ? 1.35 : 1.05 })}><RotateCcw size={14} /></button>
    </div>
  </div>;
}
