// House numbers and units in the Latin form each country uses in English. The result is undefined when a value
// holds local-script text (a village, soi or building name) that cannot be converted without inventing a
// translation; such an address is not published rather than shown with mixed script.

export const foreignScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}　-〿]/u;
const nonHanForeignScript = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}]/u;

const localDigits = (value) => value.replace(/[٠-٩۰-۹๐-๙]/gu, (digit) => {
  const code = digit.codePointAt(0);
  return String(code - (code >= 0x0E50 ? 0x0E50 : code >= 0x06F0 ? 0x06F0 : 0x0660));
});

const cyrillic = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya'
};
// Russian house numbers carry letter suffixes and designators (1А, 02 к1, 100/3 с1, 10 литА); they are transliterated.
const transliterateRussian = (value) => value.replace(/[А-Яа-яЁё]/gu, (letter) => {
  const latin = cyrillic[letter.toLowerCase()];
  return letter === letter.toLowerCase() ? latin : latin.charAt(0).toUpperCase() + latin.slice(1);
});
// Elsewhere a Cyrillic letter in a house number is a look-alike typed for the Latin one (123С, # А).
const lookalikes = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x' };
const latinLookalikes = (value) => value.replace(/[АВЕКМНОРСТХаеорсух]/gu, (letter) => lookalikes[letter]);

const kanjiDigits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export const kanjiNumber = (value) => {
  if (/^\d+$/u.test(value)) return Number(value);
  const match = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/u.exec(value);
  if (!match || !value) return undefined;
  const [, first, ten, ones] = match;
  if (!ten) return ones ? undefined : kanjiDigits[first];
  return (first ? kanjiDigits[first] : 1) * 10 + (ones ? kanjiDigits[ones] : 0);
};
const directions = { 東: 'Higashi', 西: 'Nishi', 南: 'Minami', 北: 'Kita' };
// Residence numbers (住居表示 11番10号) and land lots (地番 3122番地20) in the hyphenated form Japan Post uses in
// English: 11-10, 3122-20, 205.
export const japanEnglishHouseNumber = (value) => {
  const match = /^([東西南北])?(\d+)番(?:地)?(?:の?(\d+(?:-\d+)*)号?)?$/u.exec(String(value || '').normalize('NFKC').trim());
  if (!match) return undefined;
  const number = [match[2], match[3]].filter(Boolean).join('-');
  return match[1] ? `${directions[match[1]]} ${number}` : number;
};

// Royal Thai General System initials for the block letters that prefix some house numbers (ค.102/1).
const thaiInitials = {
  ก: 'K', ข: 'Kh', ค: 'Kh', ฆ: 'Kh', ง: 'Ng', จ: 'Ch', ฉ: 'Ch', ช: 'Ch', ซ: 'S', ญ: 'Y', ด: 'D', ต: 'T', ถ: 'Th', ท: 'Th',
  ธ: 'Th', น: 'N', บ: 'B', ป: 'P', ผ: 'Ph', ฝ: 'F', พ: 'Ph', ฟ: 'F', ภ: 'Ph', ม: 'M', ย: 'Y', ร: 'R', ล: 'L', ว: 'W', ศ: 'S',
  ษ: 'S', ส: 'S', ห: 'H', อ: 'O', ฮ: 'H'
};
const thaiPremise = (value) => value
  .replace(/[​-‍﻿]/gu, '')
  .replace(/^เลขที่\s*/u, '')
  .replace(/(?:หมู่\s*ที่|หมู่|ม\.)\s*[.-]?\s*(\d+)/gu, ' Moo $1')
  .replace(/ซอย\s*(?=[\dA-Za-z])/gu, ' Soi ')
  .replace(/^([ก-ฮ])\.\s*(?=\d)/u, (_, letter) => `${thaiInitials[letter] || letter}.`)
  .replace(/\s+/gu, ' ').replace(/[\s,]+$/u, '').trim();

const hangulLetters = { 가: 'Ga', 나: 'Na', 다: 'Da', 라: 'Ra', 마: 'Ma', 바: 'Ba', 사: 'Sa', 아: 'A', 자: 'Ja', 차: 'Cha', 카: 'Ka', 타: 'Ta', 파: 'Pa', 하: 'Ha' };
// Korean building, floor and room designators as written in English addresses: 9동 → 9-dong, 103호 → 103-ho,
// 1층 → 1F, 지하1층 → B1F, a lettered wing 가 → Ga. A bare designator without a number is dropped.
const koreanPremise = (value) => {
  if (/^[호층동]$/u.test(value)) return '';
  if (hangulLetters[value]) return hangulLetters[value];
  return value
    .replace(/지하\s*(\d+)\s*층/gu, 'B$1F')
    .replace(/(\d+)\s*층/gu, '$1F')
    .replace(/지하\s*(?=\d)/gu, 'B')
    .replace(/([\dA-Za-z][\dA-Za-z,~-]*)\s*호/gu, '$1-ho')
    .replace(/([\dA-Za-z][\dA-Za-z-]*)\s*동/gu, '$1-dong')
    .replace(/(^|\s)([가나다라마바사아자차카타파하])동/gu, (_, space, letter) => `${space}${hangulLetters[letter]}-dong`)
    .replace(/\s+/gu, ' ').trim();
};

// Hong Kong blocks: 第17座 → Block 17; a bare 座 without its number says nothing and is dropped.
const hongKongPremise = (value) => {
  if (/^座$/u.test(value)) return '';
  const block = /^第?\s*(\d+|[一二三四五六七八九十]+)\s*座$/u.exec(value);
  if (block && kanjiNumber(block[1])) return `Block ${kanjiNumber(block[1])}`;
  return value.replace(/^(\d+[A-Za-z]?)號$/u, '$1');
};

export const latinPremise = (countryCode, field, value) => {
  const source = localDigits(String(value ?? '').normalize('NFKC').trim());
  if (!foreignScript.test(source)) return source;
  const country = String(countryCode || '').toUpperCase();
  const converted = country === 'RU' ? transliterateRussian(source)
    : country === 'JP' ? (field === 'houseNumber' ? japanEnglishHouseNumber(source) : undefined)
      : country === 'TH' ? thaiPremise(source)
        : country === 'KR' ? koreanPremise(source)
          : country === 'HK' ? hongKongPremise(source)
            : latinLookalikes(source);
  return converted !== undefined && !foreignScript.test(converted) ? converted : undefined;
};

// The Chinese variant keeps Han text; a premise in another script (Cyrillic, Thai, Hangul) uses its Latin form.
export const chinesePremise = (countryCode, field, value) =>
  nonHanForeignScript.test(String(value ?? '')) ? latinPremise(countryCode, field, value) : String(value ?? '');
