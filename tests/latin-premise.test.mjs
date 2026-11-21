import { describe, expect, it } from 'vitest';
import { chinesePremise, latinPremise } from '../src/domain/latin-premise.mjs';

const cases = [
  ['JP', 'houseNumber', '11番10号', '11-10'],
  ['JP', 'houseNumber', '3122番地20', '3122-20'],
  ['JP', 'houseNumber', '205番地', '205'],
  ['RU', 'houseNumber', '1А', '1A'],
  ['RU', 'houseNumber', '02 к1', '02 k1'],
  ['RU', 'houseNumber', '100/3 с1', '100/3 s1'],
  ['RU', 'houseNumber', '10 литА', '10 litA'],
  ['RU', 'houseNumber', '101/Б', '101/B'],
  ['RU', 'unit', 'а', 'a'],
  ['TH', 'houseNumber', '100/7 หมู่4', '100/7 Moo 4'],
  ['TH', 'houseNumber', '115 หมู่ที่ 3', '115 Moo 3'],
  ['TH', 'houseNumber', '106/32 ม.9', '106/32 Moo 9'],
  ['TH', 'houseNumber', '485 หมู่-3', '485 Moo 3'],
  ['TH', 'houseNumber', '102/62 ซอย 34A', '102/62 Soi 34A'],
  ['TH', 'houseNumber', 'ค.102/1', 'Kh.102/1'],
  ['TH', 'houseNumber', 'เลขที่ 150', '150'],
  ['TH', 'houseNumber', '13/15หมู่7,', '13/15 Moo 7'],
  ['TH', 'houseNumber', '๑๒๓', '123'],
  ['KR', 'unit', '9동', '9-dong'],
  ['KR', 'unit', '103호', '103-ho'],
  ['KR', 'unit', '1층', '1F'],
  ['KR', 'unit', '지하1층 605호', 'B1F 605-ho'],
  ['KR', 'unit', '214,215호', '214,215-ho'],
  ['KR', 'unit', '가', 'Ga'],
  ['KR', 'unit', '호', ''],
  ['KR', 'houseNumber', '지하 1', 'B1'],
  ['HK', 'unit', '第17座', 'Block 17'],
  ['HK', 'unit', '座', ''],
  ['HK', 'unit', '第七座', 'Block 7'],
  ['KR', 'houseNumber', '32-16 나동', '32-16 Na-dong'],
  ['KR', 'unit', '가동 3층 370호', 'Ga-dong 3F 370-ho'],
  ['TH', 'houseNumber', '904​ หมู่​1', '904 Moo 1'],
  ['HK', 'houseNumber', '3號', '3'],
  ['SA', 'houseNumber', '٦٥٤٣', '6543'],
  ['TR', 'houseNumber', '123С', '123C'],
  ['US', 'unit', '# А', '# A'],
  ['US', 'houseNumber', '12B', '12B']
];

describe('Latin house numbers and units', () => {
  it.each(cases)('%s %s %s → %s', (country, field, value, expected) => {
    expect(latinPremise(country, field, value)).toBe(expected);
  });

  it.each([
    ['TH', 'houseNumber', 'บ้านลังกา หมู่ที่ 2'],
    ['TH', 'houseNumber', '85 ซอยบ้านตั้งสิน'],
    ['KR', 'unit', '서울역 4층 301호 (동자동)'],
    ['KR', 'unit', '상가동 207호'],
    ['HK', 'unit', '啟宏閣'],
    ['PH', 'houseNumber', '8층'],
    ['JP', 'houseNumber', '甲5番地'],
    ['TW', 'unit', 'I-yi、erlou']
  ])('refuses %s %s %s rather than mixing scripts', (country, field, value) => {
    expect(latinPremise(country, field, value)).toBeUndefined();
  });

  it('keeps Han premises in Chinese and converts other scripts', () => {
    expect(chinesePremise('JP', 'houseNumber', '11番10号')).toBe('11番10号');
    expect(chinesePremise('HK', 'unit', '第17座')).toBe('第17座');
    expect(chinesePremise('RU', 'houseNumber', '02 к1')).toBe('02 k1');
    expect(chinesePremise('KR', 'unit', '지하1층 605호')).toBe('B1F 605-ho');
    expect(chinesePremise('TH', 'houseNumber', 'บ้านลังกา')).toBeUndefined();
  });
});
