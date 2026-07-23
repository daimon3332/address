const base = process.env.API_BASE_URL || 'http://127.0.0.1:8787/api/v1';
const nativeScripts = {
  RU: /[\u0400-\u04ff]/u,
  JP: /[\u3040-\u30ff\u3400-\u9fff]/u,
  HK: /[\u3400-\u9fff]/u,
  TW: /[\u3400-\u9fff]/u,
  KR: /[\uac00-\ud7af]/u,
  CN: /[\u3400-\u9fff]/u,
  TH: /[\u0e00-\u0e7f]/u,
  SA: /[\u0600-\u06ff]/u
};
const postcodePatterns = {
  US: /^\d{5}(?:-\d{4})?$/, CA: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i, MX: /^\d{5}$/, GB: /^[A-Z0-9]{2,4} ?[A-Z0-9]{3}$/i,
  DE: /^\d{5}$/, FR: /^\d{5}$/, IT: /^\d{5}$/, ES: /^\d{5}$/, NL: /^\d{4} ?[A-Z]{2}$/i, RU: /^\d{6}$/,
  JP: /^\d{3}-?\d{4}$/, HK: /^$/, SG: /^\d{6}$/, TW: /^\d{3}(?:\d{2,3})?$/, KR: /^\d{5}$/, MY: /^\d{5}$/,
  CN: /^\d{6}$/, TH: /^\d{5}$/, PH: /^\d{4}$/, VN: /^\d{5,6}$/, TR: /^\d{5}$/, SA: /^\d{5}$/,
  IN: /^\d{6}$/, AU: /^\d{4}$/, BR: /^\d{5}-?\d{3}$/, NG: /^\d{6}$/, ZA: /^\d{4}$/
};
const nonEnglishNative = new Set([
  'RU', 'JP', 'HK', 'TW', 'KR', 'CN', 'TH', 'SA'
]);
const semanticFields = ['buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'];
const placeFields = ['locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'];
const latinLetter = /\p{Script=Latin}/u;
const letter = /\p{Letter}/u;
const hanLetter = /\p{Script=Han}/u;
const incompatibleChineseLetter = /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const usesOnlyLatinLetters = (value = '') => Array.from(value).filter((character) => letter.test(character)).every((character) => latinLetter.test(character));
const normalize = (value = '') => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const digits = (value = '') => value.replace(/\D/g, '');
const fail = (condition, message) => { if (condition) throw new Error(message); };

const registryResponse = await fetch(`${base}/countries`);
const registryPayload = await registryResponse.json();
if (!registryResponse.ok || !Array.isArray(registryPayload.data)) throw new Error('country registry unavailable');

const results = [];
let cursor = 0;
async function runner() {
  while (cursor < registryPayload.data.length) {
    const country = registryPayload.data[cursor++];
    const started = Date.now();
    try {
      let response;
      let payload;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const query = new URLSearchParams({ country: country.code, residential: 'false', seed: `localization-qa-${country.code}-v3-${attempt}` });
        response = await fetch(`${base}/generate?${query}`);
        payload = await response.json();
        if (response.ok || payload.error?.code !== 'NO_SOURCE_RESULT') break;
      }
      if (!response.ok || !payload.data?.result) throw new Error(payload.error?.code || `HTTP_${response.status}`);
      const { address, addressFormats } = payload.data.result;
      const native = address.addressVariants.native;
      const en = address.addressVariants.en;
      const zh = address.addressVariants['zh-CN'];
      fail(!native || !en || !zh, 'missing address variant');
      fail(nonEnglishNative.has(country.code) && normalize(native) === normalize(en), 'native incorrectly reuses English');
      fail(normalize(en) === normalize(zh), 'Chinese incorrectly reuses English');
      fail(!/[A-Za-z]/u.test(en), 'English variant has no Latin text');
      fail(!/[\u3400-\u9fff]/u.test(zh), 'Chinese variant has no Han text');
      fail(nativeScripts[country.code] && !nativeScripts[country.code].test(native), 'native script mismatch');

      const components = address.componentVariants;
      for (const field of semanticFields) {
        fail(components.en[field] && !usesOnlyLatinLetters(components.en[field]), `English ${field} retains non-Latin text`);
        fail(components['zh-CN'][field] && incompatibleChineseLetter.test(components['zh-CN'][field]), `Chinese ${field} retains source script`);
      }
      if (nonEnglishNative.has(country.code)) {
        for (const field of ['street', 'locality']) {
          fail(components.native[field] && !nativeScripts[country.code].test(components.native[field]), `native ${field} script mismatch`);
        }
        for (const field of placeFields) {
          fail(components['zh-CN'][field] && !hanLetter.test(components['zh-CN'][field]), `Chinese ${field} has no Han text`);
        }
      }
      const sourceHouseDigits = digits(components.native.houseNumber);
      const sourcePostcode = components.native.postcode.replace(/\s/g, '').toUpperCase();
      const sourceAdminCode = components.native.admin1Code;
      fail(Boolean(components.native.postcode) && !postcodePatterns[country.code]?.test(components.native.postcode), 'native postcode shape mismatch');
      for (const language of ['native', 'en', 'zh-CN']) {
        const value = components[language];
        fail(!value || !value.street || !value.locality, `${language} components incomplete`);
        fail(sourceHouseDigits && digits(value.houseNumber) !== sourceHouseDigits, `${language} house number changed`);
        fail(value.postcode.replace(/\s/g, '').toUpperCase() !== sourcePostcode, `${language} postcode changed`);
        fail(sourceAdminCode && value.admin1Code !== sourceAdminCode, `${language} state code changed`);
        const lines = addressFormats[language].postalLines.map(normalize);
        fail(new Set(lines).size !== lines.length, `${language} has duplicate postal lines`);
        const countryName = language === 'native' ? country.nativeName : language === 'en' ? country.name.en : country.name['zh-CN'];
        fail(lines.filter((line) => line === normalize(countryName)).length !== 1, `${language} destination country is duplicated or missing`);
      }
      results.push({ country: country.code, ok: true, ms: Date.now() - started });
    } catch (error) {
      results.push({ country: country.code, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

await Promise.all(Array.from({ length: 3 }, runner));
const failed = results.filter(({ ok }) => !ok);
console.log(JSON.stringify({ countries: results.length, passed: results.length - failed.length, failed, results }, null, 2));
if (failed.length) process.exitCode = 1;
