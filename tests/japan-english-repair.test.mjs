import { describe, expect, it } from 'vitest';
import {
  japanChineseTown, japanEnglishHouseNumber, japanLocalizedComponents, japanStreetParts, loadJapanRomaji
} from '../server/sync/japan-english-repair.mjs';

const romaji = {
  '大阪府|大阪市淀川区': { city: 'Osaka-shi', ward: 'Yodogawa-ku', county: '', towns: { 西中島: 'Nishinakajima' } },
  '愛知県|名古屋市北区': { towns: { 如意: 'Nyoi' } },
  '東京都|足立区': { towns: { 竹の塚: 'Takenotsuka' } },
  '北海道|札幌市西区': { towns: { 八軒八条西: 'Hachiken Hachijonishi' } }
};

describe('Japanese English and Chinese address fields', () => {
  it('writes house numbers in the hyphenated English form', () => {
    expect(japanEnglishHouseNumber('11番10号')).toBe('11-10');
    expect(japanEnglishHouseNumber('3122番地20')).toBe('3122-20');
    expect(japanEnglishHouseNumber('205番地')).toBe('205');
    expect(japanEnglishHouseNumber('10番39-6号')).toBe('10-39-6');
    expect(japanEnglishHouseNumber('東5番21号')).toBe('Higashi 5-21');
    expect(japanEnglishHouseNumber('５番地')).toBe('5');
    expect(japanEnglishHouseNumber('甲5番地')).toBeUndefined();
  });

  it('splits the stored street into town and chome', () => {
    expect(japanStreetParts('如意五丁目', '如意')).toEqual({ town: '如意', chome: 5 });
    expect(japanStreetParts('前田七条十七丁目', '前田七条')).toEqual({ town: '前田七条', chome: 17 });
    expect(japanStreetParts('上野幌一条一丁目', '上野幌一条')).toEqual({ town: '上野幌一条', chome: 1 });
    expect(japanStreetParts('弁天4丁目', '弁天')).toEqual({ town: '弁天', chome: 4 });
    expect(japanStreetParts('弁天', '弁天')).toEqual({ town: '弁天', chome: undefined });
    expect(japanStreetParts('弁天北', '弁天')).toBeUndefined();
  });

  it('keeps Japanese town kanji in Chinese and replaces only kana connectors', () => {
    expect(japanChineseTown('西中島')).toBe('西中島');
    expect(japanChineseTown('竹の塚')).toBe('竹之塚');
    expect(japanChineseTown('虎ノ門')).toBe('虎之門');
    expect(japanChineseTown('千駄ケ谷')).toBe('千駄谷');
    expect(japanChineseTown('向が丘')).toBe('向丘');
    expect(japanChineseTown('つつじが丘')).toBeUndefined();
  });

  it('replaces machine translations with the registry romanization and leaves no Japanese script in English', () => {
    const variants = {
      native: { houseNumber: '1番地3', street: '西中島四丁目', district: '西中島', locality: '大阪市淀川区', admin1: '大阪府', postcode: '532-0011' },
      en: { houseNumber: '1番地3', street: 'The four western central islands', district: 'Nishinakajima', locality: 'Yodogawa Ward, Osaka City', admin1: 'Ōsaka', postcode: '532-0011' },
      'zh-CN': { houseNumber: '1番地3', street: '中西四岛', district: '西中岛', locality: '大阪市淀川区', admin1: '大阪', postcode: '532-0011' }
    };
    const localized = japanLocalizedComponents(variants, romaji);
    expect(localized.en).toMatchObject({ houseNumber: '1-3', street: 'Nishinakajima 4-chome', district: 'Nishinakajima',
      locality: 'Yodogawa-ku, Osaka-shi', admin1: 'Ōsaka' });
    expect(localized['zh-CN']).toMatchObject({ street: '西中島4丁目', district: '西中島', houseNumber: '1番地3', locality: '大阪市淀川区' });
    expect(localized.native).toBe(variants.native);
    expect(Object.values(localized.en).join(' ')).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);

    const sapporo = japanLocalizedComponents({
      native: { houseNumber: '2番10号', street: '八軒八条西十丁目', district: '八軒八条西', locality: '札幌市西区', admin1: '北海道' },
      en: { street: 'Hachiken Hachijo Nishi 10th-chome', district: 'Hachiken Hachijo West' }, 'zh-CN': {}
    }, romaji);
    expect(sapporo.en).toMatchObject({ houseNumber: '2-10', street: 'Hachiken Hachijonishi 10-chome' });
    expect(japanLocalizedComponents({ native: { houseNumber: '1番1号', street: '無名一丁目', district: '無名', locality: '足立区', admin1: '東京都' },
      en: {}, 'zh-CN': {} }, romaji)).toBeUndefined();
  });

  it('ships a romanization for every town the published pool uses', async () => {
    const table = await loadJapanRomaji();
    expect(Object.keys(table).length).toBeGreaterThan(250);
    expect(table['東京都|港区'].towns['虎ノ門']).toBe('Toranomon');
    expect(table['愛知県|名古屋市北区'].towns['如意']).toBe('Nyoi');
    for (const city of Object.values(table)) {
      for (const name of Object.values(city.towns)) expect(name).toMatch(/^[A-Z\d][A-Za-z\d' -]*$/u);
    }
  });
});
