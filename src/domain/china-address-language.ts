import { pinyin } from './pinyin-runtime';

type ChinaField = 'admin1' | 'locality' | 'district' | 'township' | 'street' | 'buildingName';
type Suffix = readonly [string, string];
const suffixes: Record<ChinaField, readonly Suffix[]> = {
  admin1: [['特别行政区', 'Special Administrative Region'], ['自治区', 'Autonomous Region'], ['省', 'Province'], ['市', 'Municipality']],
  locality: [['自治州', 'Autonomous Prefecture'], ['地区', 'Prefecture'], ['市', 'City'], ['区', 'District'], ['县', 'County']],
  district: [['自治县', 'Autonomous County'], ['新区', 'New Area'], ['区', 'District'], ['县', 'County'], ['镇', 'Town']],
  township: [['街道', 'Subdistrict'], ['镇', 'Town'], ['乡', 'Township'], ['村', 'Village']],
  street: [['高速公路', 'Expressway'], ['大道', 'Avenue'], ['大街', 'Street'], ['公路', 'Highway'], ['胡同', 'Hutong'], ['街道', 'Subdistrict'], ['路', 'Road'], ['街', 'Street'], ['巷', 'Lane'], ['弄', 'Lane'], ['村', 'Village']],
  buildingName: [['住宅小区', 'Residential Community'], ['生活小区', 'Residential Community'], ['居住区', 'Residential Community'], ['生活区', 'Residential Community'], ['小区', 'Residential Community'], ['社区', 'Community'], ['家园', 'Residential Community'], ['花园', 'Garden'], ['名苑', 'Residential Estate'], ['公寓', 'Apartments'], ['大厦', 'Building']]
};
const conventionalNames: Record<string, string> = {
  陕西: 'Shaanxi', 内蒙古: 'Inner Mongolia', 西藏: 'Tibet',
  广西壮族: 'Guangxi Zhuang', 宁夏回族: 'Ningxia Hui', 新疆维吾尔: 'Xinjiang Uyghur'
};

const romanizeName = (value: string): string => value.replace(/\p{Script=Han}+/gu, (name, offset: number, source: string) => {
  const syllables = pinyin(name, { toneType: 'none', type: 'array', nonZh: 'consecutive' });
  const word = syllables.map((part, index) => `${index && /^[aeo]/u.test(part) ? "'" : ''}${part}`).join('');
  const separated = `${offset && /[A-Za-z\d]/u.test(source[offset - 1]) ? ' ' : ''}${word.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())}`;
  return `${separated}${/[A-Za-z\d]/u.test(source[offset + name.length] || '') ? ' ' : ''}`;
}).replace(/\s+/gu, ' ').trim();

export const chinaEnglishComponent = (field: ChinaField, value: string): string => {
  const source = value.normalize('NFKC').trim();
  if (field === 'street') {
    const nested = source.match(/^(.+?(?:街道|镇|乡|村))(.+(?:大道|大街|公路|路|街|巷|弄|胡同))$/u);
    if (nested) return `${chinaEnglishComponent('street', nested[2])}, ${chinaEnglishComponent('township', nested[1])}`;
    const section = source.match(/^(.+(?:路|街|公路))([东西南北])段$/u);
    if (section) {
      const direction: Record<string, string> = { 东: 'East', 西: 'West', 南: 'South', 北: 'North' };
      return `${chinaEnglishComponent('street', section[1])} (${direction[section[2]]} Section)`;
    }
  }
  const suffix = suffixes[field].find(([candidate]) => source.endsWith(candidate));
  const stem = suffix ? source.slice(0, -suffix[0].length) : source;
  const name = field === 'admin1' ? conventionalNames[stem] || romanizeName(stem) : romanizeName(stem);
  return [name, suffix?.[1]].filter(Boolean).join(' ');
};

const pinyinSuffixes = [...new Set(Object.values(suffixes).flat().map(([suffix]) => suffix)
  .concat(['号', '號', '栋', '幢', '楼', '单元', '室', '院']))].sort((left, right) => right.length - left.length);

export const chinaPinyinComponent = (value: string): string => {
  const source = value.normalize('NFKC').trim();
  const suffix = pinyinSuffixes.find((candidate) => source.endsWith(candidate));
  return suffix ? [romanizeName(source.slice(0, -suffix.length)), romanizeName(suffix)].filter(Boolean).join(' ')
    : romanizeName(source);
};

export const chinaEnglishPremiseNumber = (value: string): string => {
  const source = value.replace(/(?:号|號)(?:院|楼|栋|棟)?$/u, '');
  const lane = source.match(/^([0-9A-Za-z-]+)[弄巷](.+)$/u);
  return lane ? `${lane[2]}, Lane ${lane[1]}` : source;
};
