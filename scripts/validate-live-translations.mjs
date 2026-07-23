const base = process.env.API_BASE_URL || 'http://127.0.0.1:8787/api/v1';
const registry = await (await fetch(`${base}/countries`)).json();
const codes = registry.data.map((country) => country.code);
const localScript = {
  CN: /[\u3400-\u9fff]/, HK: /[\u3400-\u9fff]/, TW: /[\u3400-\u9fff]/,
  JP: /[\u3040-\u30ff\u3400-\u9fff]/, KR: /[\uac00-\ud7af]/,
  RU: /[\u0400-\u04ff]/, SA: /[\u0600-\u06ff]/, TH: /[\u0e00-\u0e7f]/
};
const nonEnglish = new Set(['RU', 'JP', 'HK', 'TW', 'KR', 'CN', 'TH', 'SA']);
const nonChinese = new Set(codes.filter((code) => !['CN', 'HK', 'TW'].includes(code)));
const results = [];
let cursor = 0;

async function runner() {
  while (cursor < codes.length) {
    const country = codes[cursor++];
    try {
      const response = await fetch(`${base}/generate?${new URLSearchParams({ country, residential: 'false', seed: `translation-${country}-v3` })}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.code || String(response.status));
      const address = payload.data.result.address;
      if (localScript[country] && !localScript[country].test(address.addressVariants.native)) throw new Error('Original script mismatch');
      if (nonEnglish.has(country) && address.addressVariants.en === address.addressVariants.native) throw new Error('English did not change');
      if (nonChinese.has(country) && address.addressVariants['zh-CN'] === address.addressVariants.native) throw new Error('Chinese did not change');
      if (!/[A-Za-z]/.test(address.addressVariants.en)) throw new Error('English has no Latin text');
      if (!/[\u3400-\u9fff]/.test(address.addressVariants['zh-CN'])) throw new Error('Chinese has no Han text');
      for (const field of ['street', 'locality', 'admin1']) {
        if (address.componentVariants.native[field] && (!address.componentVariants.en[field] || !address.componentVariants['zh-CN'][field])) throw new Error(`${field} translation is empty`);
      }
      results.push({ country, ok: true, native: address.addressVariants.native, en: address.addressVariants.en, zh: address.addressVariants['zh-CN'] });
    } catch (error) {
      results.push({ country, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

await Promise.all(Array.from({ length: 3 }, runner));
const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ countries: results.length, passed: results.length - failed.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
