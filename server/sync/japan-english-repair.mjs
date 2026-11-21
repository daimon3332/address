import { readFile } from 'node:fs/promises';
import { japanEnglishHouseNumber, kanjiNumber } from '../../src/domain/latin-premise.mjs';
import { formattedAddress } from './address-etl.mjs';

export { japanEnglishHouseNumber };

// v2 also writes the city from the registry and covers rows that were unpublished when v1 ran.
export const JAPAN_ENGLISH_REVISION = 'japan-romaji-v2';

// A Japanese town keeps its own name in Chinese: the kanji stay as written and only the kana connectors change
// (竹の塚 → 竹之塚, 千駄ケ谷 → 千駄谷, 向が丘 → 向丘). Undefined when other kana remain.
export const japanChineseTown = (value) => {
  const text = String(value || '').replace(/[のノ]/gu, '之').replace(/(?<=\p{Script=Han})[ヶケが](?=\p{Script=Han})/gu, '');
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? undefined : text;
};

// Splits a stored street such as 如意五丁目 into its town (如意, the stored district) and chome number (5).
export const japanStreetParts = (street, town) => {
  const text = String(street || '');
  if (!town || !text.startsWith(town)) return undefined;
  const rest = text.slice(town.length);
  if (!rest) return { town, chome: undefined };
  const chome = /^(\d+|[一二三四五六七八九十]+)丁目$/u.exec(rest.normalize('NFKC'));
  const number = chome ? kanjiNumber(chome[1]) : undefined;
  return number ? { town, chome: number } : undefined;
};

export const loadJapanRomaji = async (file = new URL('./japan-romaji.json', import.meta.url)) =>
  JSON.parse(await readFile(file, 'utf8')).cities;

// English and Chinese city, town and house fields rebuilt from the native ones: the city and town romanized as the
// Address Base Registry writes them (Sawara-ku, Fukuoka-shi), the house number hyphenated; in Chinese the official
// kanji. Undefined when a field cannot be derived.
export const japanLocalizedComponents = (variants, romaji) => {
  const native = variants.native || {};
  const parts = japanStreetParts(native.street, native.district);
  const city = romaji[`${native.admin1}|${native.locality}`];
  const town = parts && city?.towns[parts.town];
  const houseNumber = japanEnglishHouseNumber(native.houseNumber);
  if (!parts || !town || !houseNumber) return undefined;
  const chineseTown = japanChineseTown(parts.town);
  const chome = parts.chome ? ` ${parts.chome}-chome` : '';
  const locality = [city.ward, city.city, city.county].filter(Boolean).join(', ');
  const chineseLocality = japanChineseTown(native.locality);
  const en = { ...variants.en, houseNumber, street: `${town}${chome}`, district: town, locality,
    ...(native.postalLocality ? { postalLocality: native.postalLocality === native.locality ? locality : variants.en.postalLocality } : {}) };
  const zh = { ...variants['zh-CN'], houseNumber: native.houseNumber,
    ...(chineseLocality ? { locality: chineseLocality, ...(native.postalLocality === native.locality ? { postalLocality: chineseLocality } : {}) } : {}),
    street: chineseTown ? `${chineseTown}${parts.chome ? `${parts.chome}丁目` : ''}` : en.street, district: chineseTown || town };
  for (const variant of [en, zh]) if (!native.dependentLocality) delete variant.dependentLocality;
  return { ...variants, en, 'zh-CN': zh };
};

export const repairJapaneseLocalizedAddresses = async ({ database, romaji, now = () => new Date() }) => {
  const key = `${JAPAN_ENGLISH_REVISION}:JP`;
  const summary = { countryCode: 'JP', repaired: 0, unresolved: 0 };
  if (await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(key).first('value_json')) return summary;
  const table = romaji || await loadJapanRomaji();
  const rows = (await database.prepare(`SELECT id,component_variants_json,address_variants_json FROM address_pool
    WHERE country_code='JP' ORDER BY id`).all()).results;
  await database.transaction(async (transaction) => {
    for (const row of rows) {
      const variants = JSON.parse(row.component_variants_json || '{}');
      const localized = japanLocalizedComponents(variants, table);
      if (!localized) { summary.unresolved += 1; continue; }
      const addresses = JSON.parse(row.address_variants_json || '{}');
      await transaction.prepare('UPDATE address_pool SET component_variants_json=?,address_variants_json=? WHERE id=?')
        .bind(JSON.stringify(localized), JSON.stringify({ ...addresses,
          en: formattedAddress(localized.en, 'JP'), 'zh-CN': formattedAddress(localized['zh-CN'], 'JP') }), row.id).run();
      summary.repaired += 1;
    }
    await transaction.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(key, JSON.stringify({ done: true, ...summary }), now().toISOString()).run();
  });
  return summary;
};
