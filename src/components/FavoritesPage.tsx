import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bookmark, Copy, ExternalLink, GripVertical, Trash2 } from 'lucide-react';
import { addressDisplayPresentation, type AddressDisplayLanguage } from '../domain/address-display';
import { countries, countryByCode } from '../domain/countries';
import { safeExternalUrl, type FavoriteAddress } from '../domain/favorites';
import { favoritesCopy, type FavoritesCopy } from '../domain/favorites-i18n';
import { messages } from '../domain/i18n';
import { pinyinStore } from '../domain/pinyin-runtime';
import { localeDefinitions, localizedCountryName, pathForLocale } from '../domain/locales';
import type { CountryCode, CountryGroup, Locale } from '../domain/types';
import { listFavorites, removeFavorite, reorderFavorite, restoreFavorite, subscribeToFavorites } from '../services/favorite-store';

interface Props { locale: Locale }
type GroupMode = 'continent' | 'country';
const groupOrder: CountryGroup[] = ['north-america', 'europe', 'east-asia', 'southeast-asia', 'south-asia', 'oceania', 'middle-east', 'south-america', 'africa'];
const groupMessage = {
  'north-america': 'northAmerica', europe: 'europe', 'east-asia': 'eastAsia', 'southeast-asia': 'southeastAsia',
  'south-asia': 'southAsia', oceania: 'oceania', 'middle-east': 'middleEast', 'south-america': 'southAmerica', africa: 'africa'
} as const;
const groupNames = (locale: Locale, group: CountryGroup): string => messages[locale][groupMessage[group]];

export default function FavoritesPage({ locale }: Props) {
  const text = favoritesCopy[locale];
  const [favorites, setFavorites] = useState<FavoriteAddress[]>([]);
  const [persistent, setPersistent] = useState(true);
  const [ready, setReady] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>('continent');
  const [continent, setContinent] = useState<CountryGroup | ''>('');
  const [country, setCountry] = useState<CountryCode | ''>('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const mutationPending = useRef(false);
  const refreshId = useRef(0);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string; removed?: FavoriteAddress } | null>(null);
  const feedbackTimer = useRef<number | undefined>(undefined);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const refresh = async () => {
    const id = ++refreshId.current;
    const result = await listFavorites();
    if (id === refreshId.current) { setFavorites(result.values); setPersistent(result.persistent); setReady(true); }
  };
  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeToFavorites(() => void refresh());
    return () => { refreshId.current += 1; unsubscribe(); window.clearTimeout(feedbackTimer.current); };
  }, []);

  const showFeedback = (value: typeof feedback) => {
    window.clearTimeout(feedbackTimer.current);
    setFeedback(value);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 4000);
  };

  const mutate = async (action: () => Promise<void>): Promise<void> => {
    if (mutationPending.current) return;
    mutationPending.current = true; setBusy(true);
    try { await action(); }
    catch { showFeedback({ kind: 'error', message: text.updateFailed, removed: feedback?.removed }); }
    finally { mutationPending.current = false; setBusy(false); }
  };
  const moveAddress = (id: string, position: number) => mutate(async () => {
    await reorderFavorite(id, position); await refresh();
  });

  const availableCountries = useMemo(() => countries.filter((item) => favorites.some((favorite) => favorite.countryCode === item.code)
    && (!continent || item.group === continent)), [favorites, continent]);
  const visible = useMemo(() => favorites.filter((favorite) => (!continent || favorite.continent === continent)
    && (!country || favorite.countryCode === country)), [favorites, continent, country]);
  const countrySections = useMemo(() => countries.map((item) => ({ country: item, values: visible
    .filter((favorite) => favorite.countryCode === item.code).sort((left, right) => left.position - right.position) }))
    .filter(({ values }) => values.length), [visible]);

  const dragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const target = favorites.find((favorite) => favorite.id === over.id);
    const source = favorites.find((favorite) => favorite.id === active.id);
    if (!source || !target || source.countryCode !== target.countryCode) return;
    await moveAddress(source.id, target.position);
  };
  const copyAddress = async (favorite: FavoriteAddress) => {
    const presentation = addressDisplayPresentation(favorite.snapshot, storedAddressLanguage(), locale);
    try {
      await copyText(presentation.singleLine);
      setCopied(favorite.id); showFeedback({ kind: 'success', message: text.copied });
      window.setTimeout(() => setCopied(''), 1200);
    } catch { showFeedback({ kind: 'error', message: text.copyFailed }); }
  };

  const removeAddress = (id: string) => mutate(async () => {
    const removed = favorites.find((favorite) => favorite.id === id);
    if (!removed || !await removeFavorite(id)) return;
    await refresh();
    showFeedback({ kind: 'success', message: text.removed, removed });
  });

  const undoRemove = () => mutate(async () => {
    if (!feedback?.removed) return;
    await restoreFavorite(feedback.removed);
    await refresh();
    showFeedback({ kind: 'success', message: text.saved });
  });

  const renderCountry = ({ country: configured, values }: typeof countrySections[number]) => <FavoriteCountrySection
    key={configured.code} countryCode={configured.code} values={values} locale={locale} text={text} copied={copied}
    remove={removeAddress} copy={copyAddress} busy={busy} move={moveAddress} />;

  const groupedByContinent = groupOrder.map((group) => ({ group, countries: countrySections.filter(({ country: item }) => item.group === group) }))
    .filter(({ countries: values }) => values.length);

  return <div className="favorites-shell">
    <header className="topbar favorites-topbar">
      <a className="logo" href={`/${locale}/`}><b>{text.back}</b></a>
      <nav className="top-links">
        <select className="language-select" aria-label="Language" value={locale} onChange={(event) => {
          window.location.assign(pathForLocale(window.location.pathname, event.target.value as Locale));
        }}>{localeDefinitions.map((definition) => <option key={definition.code} value={definition.code}>{definition.label}</option>)}</select>
      </nav>
    </header>
    <main className="favorites-page">
      <header className="favorites-heading"><div><Bookmark aria-hidden="true"/><h1>{text.title}</h1></div><span>{favorites.length.toLocaleString(locale)} {text.count}</span></header>
      {!persistent && <p className="favorites-storage-warning" role="status">{text.temporary}</p>}
      <section className="favorites-toolbar" aria-label={text.title}>
        <div className="favorites-segmented" role="group" aria-label={text.groupBy}>
          <button type="button" aria-pressed={groupMode === 'continent'} onClick={() => setGroupMode('continent')}>{text.byContinent}</button>
          <button type="button" aria-pressed={groupMode === 'country'} onClick={() => setGroupMode('country')}>{text.byCountry}</button>
        </div>
        <label><span>{text.filterContinent}</span><select value={continent} onChange={(event) => { setContinent(event.target.value as CountryGroup | ''); setCountry(''); }}>
          <option value="">{text.allContinents}</option>{groupOrder.map((group) => <option value={group} key={group}>{groupNames(locale, group)}</option>)}
        </select></label>
        <label><span>{text.filterCountry}</span><select value={country} onChange={(event) => setCountry(event.target.value as CountryCode | '')}>
          <option value="">{text.allCountries}</option>{availableCountries.map((item) => <option value={item.code} key={item.code}>{localizedCountryName(item.code, locale, item.name.en)}</option>)}
        </select></label>
      </section>
      {!ready ? <p className="favorites-empty">...</p> : !favorites.length ? <p className="favorites-empty">{text.empty}</p>
        : !visible.length ? <p className="favorites-empty">{text.noResults}</p>
          : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void dragEnd(event)}>
            <div className="favorites-groups">{groupMode === 'continent'
              ? groupedByContinent.map(({ group, countries: values }) => <section className="favorites-continent" key={group}><h2>{groupNames(locale, group)}</h2>{values.map(renderCountry)}</section>)
              : countrySections.map(renderCountry)}</div>
          </DndContext>}
    </main>
    {feedback && <div className={`copy-toast ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true"><span aria-hidden="true">{feedback.kind === 'success' ? '✓' : '!'}</span>{feedback.message}{feedback.removed && <button type="button" disabled={busy} onClick={() => void undoRemove()}>{text.undo}</button>}</div>}
  </div>;
}

const copyText = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {}
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('COPY_FAILED');
};

const storedAddressLanguage = (): AddressDisplayLanguage => {
  try {
    const value = localStorage.getItem('address-generator-address-language');
    return value === 'native' || localeDefinitions.some(({ code }) => code === value) ? value as AddressDisplayLanguage : 'en';
  } catch { return 'en'; }
};

function FavoriteCountrySection({ countryCode, values, locale, text, copied, remove, copy, move, busy }: {
  countryCode: CountryCode; values: FavoriteAddress[]; locale: Locale; text: FavoritesCopy; copied: string; busy: boolean;
  remove: (id: string) => Promise<void>; copy: (favorite: FavoriteAddress) => Promise<void>; move: (id: string, position: number) => Promise<void>;
}) {
  const country = countryByCode.get(countryCode)!;
  return <section className="favorites-country"><header><h3><img src={`/flags/${countryCode.toLowerCase()}.svg`} width="24" height="18" alt="" loading="lazy" decoding="async"/>{localizedCountryName(countryCode, locale, country.name.en)}</h3><span>{values.length}</span></header>
    <SortableContext items={values.map(({ id }) => id)} strategy={verticalListSortingStrategy}>
      <div className="favorites-list" aria-busy={busy}>{values.map((favorite) => <FavoriteRow key={favorite.id} favorite={favorite} total={values.length} locale={locale} text={text} copied={copied} remove={remove} copy={copy} move={move} busy={busy}/>)}</div>
    </SortableContext>
  </section>;
}

function FavoriteRow({ favorite, total, locale, text, copied, remove, copy, move, busy }: {
  favorite: FavoriteAddress; total: number; locale: Locale; text: FavoritesCopy; copied: string; busy: boolean;
  remove: (id: string) => Promise<void>; copy: (favorite: FavoriteAddress) => Promise<void>; move: (id: string, position: number) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: favorite.id, disabled: busy });
  const [position, setPosition] = useState(String(favorite.position));
  useEffect(() => setPosition(String(favorite.position)), [favorite.position]);
  useSyncExternalStore(...pinyinStore);
  const presentation = addressDisplayPresentation(favorite.snapshot, storedAddressLanguage(), locale);
  const google = safeExternalUrl(favorite.snapshot.googleMaps.openUrl);
  const amap = safeExternalUrl(favorite.snapshot.googleMaps.amapUrl);
  const commit = () => { const target = Math.max(1, Math.min(total, Number.parseInt(position, 10) || favorite.position)); setPosition(String(target)); void move(favorite.id, target); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } };
  return <article ref={setNodeRef} className={`favorite-row ${isDragging ? 'dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button type="button" className="favorite-drag" disabled={busy} title={text.drag} aria-label={text.drag} {...attributes} {...listeners}><GripVertical aria-hidden="true"/></button>
    <div className="favorite-address"><strong>{presentation.singleLine}</strong><small>{favorite.snapshot.address.components.postcode} · {new Date(favorite.createdAt).toLocaleDateString(locale)}</small></div>
    <label className="favorite-position"><span>{text.position}</span><input type="number" disabled={busy} min="1" max={total} inputMode="numeric" value={position} onChange={(event) => setPosition(event.target.value)} onBlur={commit} onKeyDown={keyDown}/></label>
    <div className="favorite-actions">
      <button type="button" title={text.copy} aria-label={text.copy} onClick={() => void copy(favorite)}>{copied === favorite.id ? '✓' : <Copy aria-hidden="true"/>}</button>
      {google && <a href={google} target="_blank" rel="noreferrer" title={text.openGoogle} aria-label={text.openGoogle}><ExternalLink aria-hidden="true"/></a>}
      {amap && <a href={amap} target="_blank" rel="noreferrer" title={text.openAmap} aria-label={text.openAmap}><ExternalLink aria-hidden="true"/></a>}
      <button type="button" className="favorite-remove" disabled={busy} title={text.remove} aria-label={text.remove} onClick={() => void remove(favorite.id)}><Trash2 aria-hidden="true"/></button>
    </div>
  </article>;
}
