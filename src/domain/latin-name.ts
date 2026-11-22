import { Converter } from 'opencc-js/t2cn';
import { foreignScript, transliterateRussian } from './latin-premise.mjs';
import { pinyin } from './pinyin-runtime';
import type { CountryCode } from './types';

// The recipient name in English addresses. Chinese names use Hanyu Pinyin (Taiwan hyphenates the given name),
// Korean names the Revised Romanization with the customary spelling of common surnames, Russian names the passport
// transliteration. Japanese kanji, Thai and Arabic names have no reliable reading from the script alone and are
// left as generated.
const toSimplified = Converter({ from: 'tw', to: 'cn' });
const capitalize = (value: string): string => value.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());

const pinyinSyllables = (value: string, surname: boolean): string[] =>
  pinyin(toSimplified(value), { toneType: 'none', type: 'array', surname: surname ? 'all' : 'off' })
    .map((syllable) => syllable.replace(/([ln])ü/gu, '$1yu').replace(/ü/gu, 'u'));
const joinedPinyin = (syllables: string[]): string =>
  capitalize(syllables.map((syllable, index) => `${index && /^[aeo]/u.test(syllable) ? "'" : ''}${syllable}`).join(''));

const initials = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const medials = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const finals = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const koreanSurnames: Record<string, string> = {
  김: 'Kim', 이: 'Lee', 박: 'Park', 최: 'Choi', 정: 'Jung', 강: 'Kang', 조: 'Cho', 윤: 'Yoon', 임: 'Lim', 오: 'Oh',
  신: 'Shin', 권: 'Kwon', 안: 'Ahn', 유: 'Yoo', 노: 'Noh', 심: 'Shim', 문: 'Moon', 우: 'Woo', 주: 'Joo', 구: 'Koo',
  고: 'Ko', 곽: 'Kwak', 공: 'Kong', 기: 'Ki', 길: 'Kil', 금: 'Keum', 국: 'Kook', 경: 'Kyung', 성: 'Sung', 선: 'Sun',
  변: 'Byun', 현: 'Hyun', 형: 'Hyung', 명: 'Myung', 육: 'Yook', 추: 'Choo', 부: 'Boo', 두: 'Doo'
};
const hangulSyllable = (syllable: string): string => {
  const index = (syllable.codePointAt(0) ?? 0) - 0xac00;
  if (index < 0 || index > 11171) return syllable;
  return `${initials[Math.floor(index / 588)]}${medials[Math.floor((index % 588) / 28)]}${finals[index % 28]}`;
};
const romanizedHangul = (value: string): string => capitalize([...value].map(hangulSyllable).join('-'));

export const latinPersonName = (
  countryCode: CountryCode,
  fullName: string,
  lastName: string,
  firstName: string
): string | undefined => {
  const latin = countryCode === 'CN'
    ? `${joinedPinyin(pinyinSyllables(lastName, true))} ${joinedPinyin(pinyinSyllables(firstName, false))}`
    : countryCode === 'TW'
      ? `${joinedPinyin(pinyinSyllables(lastName, true))} ${capitalize(pinyinSyllables(firstName, false).join('-'))}`
      : countryCode === 'KR'
        ? `${koreanSurnames[lastName] || romanizedHangul(lastName)} ${romanizedHangul(firstName)}`
        : countryCode === 'RU' ? transliterateRussian(fullName) : undefined;
  return latin && !foreignScript.test(latin) ? latin : undefined;
};
