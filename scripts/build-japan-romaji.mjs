// Builds server/sync/japan-romaji.json: the official Address Base Registry romanization of every Japanese town
// (大字・町) in every city the published pool uses. Input: a CSV of prefecture,city,town,street rows exported from the pool.
// Where the registry has a katakana reading but no romaji, the reading is romanized (Hepburn, long vowels
// shortened as the registry's own romaji does).
// Usage: node scripts/build-japan-romaji.mjs <towns.csv> [output]
import { readFile, writeFile } from 'node:fs/promises';

const base = 'https://japanese-addresses-v2.geoloniamaps.com/api/ja';
const [input, output = 'server/sync/japan-romaji.json'] = process.argv.slice(2);
const fetchJson = async (url) => {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((error) => error);
    if (response instanceof Response && response.ok) return response.json();
    if (attempt === 4) throw new Error(`${url}: ${response?.status || response?.message}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
};
const csvRow = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/gu)].map((match) => match[1].replace(/^"|"$/gu, '').replace(/""/gu, '"')).slice(0, 4);
const spelling = (value) => String(value || '').replace(/[ヶケ]/gu, 'ケ').replace(/[ノの]/gu, 'ノ');

const kana = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo', シャ: 'sha', シュ: 'shu', ショ: 'sho', チャ: 'cha', チュ: 'chu', チョ: 'cho',
  ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo', ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo', ミャ: 'mya', ミュ: 'myu', ミョ: 'myo',
  リャ: 'rya', リュ: 'ryu', リョ: 'ryo', ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo', ジャ: 'ja', ジュ: 'ju', ジョ: 'jo',
  ビャ: 'bya', ビュ: 'byu', ビョ: 'byo', ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo',
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', サ: 'sa', シ: 'shi', ス: 'su',
  セ: 'se', ソ: 'so', タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho', マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo', ヤ: 'ya', ユ: 'yu',
  ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヲ: 'o', ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge',
  ゴ: 'go', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do', バ: 'ba',
  ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', ヴ: 'vu'
};
export const romanizeKatakana = (reading) => {
  let text = '';
  const source = String(reading || '').normalize('NFKC');
  for (let index = 0; index < source.length; index += 1) {
    const pair = kana[source.slice(index, index + 2)];
    const syllable = pair || kana[source[index]];
    if (pair) index += 1;
    if (source[index] === 'ッ' && !pair) { text += '\u0000'; continue; }
    if (source[index] === 'ン' && !pair) { text += 'n'; continue; }
    if (source[index] === 'ー' && !pair) continue;
    if (!syllable) return '';
    text += syllable;
  }
  const word = text.replace(/\u0000(ch)/gu, 't$1').replace(/\u0000(.)/gu, '$1$1').replace(/\u0000/gu, '')
    .replace(/n(?=[bmp])/gu, 'n').replace(/ou/gu, 'o').replace(/uu/gu, 'u').replace(/oo/gu, 'o');
  return word ? word[0].toUpperCase() + word.slice(1) : '';
};

const wanted = new Map();
for (const line of (await readFile(input, 'utf8')).split(/\r?\n/u).filter(Boolean)) {
  const [prefecture, city, town] = csvRow(line);
  const key = `${prefecture}|${city}`;
  if (!wanted.has(key)) wanted.set(key, new Set());
  wanted.get(key).add(town);
}
const index = (await fetchJson(`${base}.json`)).data;
const table = {};
const missing = [];
let romanized = 0;
for (const [key, towns] of [...wanted].sort(([left], [right]) => left.localeCompare(right))) {
  const [prefecture, city] = key.split('|');
  const entry = index.find((item) => item.pref === prefecture);
  const unit = entry?.cities.find((item) => [`${item.city}${item.ward || ''}`, `${item.county || ''}${item.city}${item.ward || ''}`].includes(city));
  if (!unit) { missing.push(key); continue; }
  const path = `${unit.county || ''}${unit.city}${unit.ward || ''}`;
  const machiaza = (await fetchJson(`${base}/${encodeURIComponent(prefecture)}/${encodeURIComponent(path)}.json`)).data;
  const romaji = new Map();
  for (const item of machiaza) {
    if (!item.oaza_cho || romaji.has(spelling(item.oaza_cho))) continue;
    const name = item.oaza_cho_r || romanizeKatakana(item.oaza_cho_k);
    if (!item.oaza_cho_r && name) romanized += 1;
    if (name) romaji.set(spelling(item.oaza_cho), name);
  }
  // Every town of the city goes in, so the table is the registry's own data and covers rows published later.
  const found = Object.fromEntries([...new Map(machiaza.filter((item) => item.oaza_cho && romaji.has(spelling(item.oaza_cho)))
    .map((item) => [item.oaza_cho, romaji.get(spelling(item.oaza_cho))]))].sort(([left], [right]) => left.localeCompare(right)));
  for (const town of towns) if (!found[town] && !romaji.has(spelling(town))) missing.push(`${key}|${town}`);
  for (const town of towns) if (!found[town] && romaji.has(spelling(town))) found[town] = romaji.get(spelling(town));
  table[key] = { prefecture: entry.pref_r, county: unit.county_r || '', city: unit.city_r, ward: unit.ward_r || '', towns: found };
}
await writeFile(output, `${JSON.stringify({ source: 'Digital Agency Address Base Registry via Geolonia japanese-addresses-v2', cities: table }, null, 1)}\n`);
console.log(`cities=${Object.keys(table).length} towns=${Object.values(table).reduce((total, city) => total + Object.keys(city.towns).length, 0)} romanizedFromKana=${romanized} missing=${missing.length}`);
for (const item of missing.slice(0, 40)) console.log('missing', item);
