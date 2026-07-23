import type { SandboxCard } from './types';

type RandomSource = () => number;

interface NetworkSpec {
  network: SandboxCard['network'];
  prefixes: Array<string | [number, number]>;
  length: number;
  cvcLength: number;
  grouping: number[];
}

const networkSpecs: NetworkSpec[] = [
  { network: 'Visa', prefixes: ['4'], length: 16, cvcLength: 3, grouping: [4, 4, 4, 4] },
  { network: 'Mastercard', prefixes: [[51, 55], [2221, 2720]], length: 16, cvcLength: 3, grouping: [4, 4, 4, 4] }
];

const digits = (random: RandomSource, length: number): string =>
  Array.from({ length }, () => Math.floor(random() * 10)).join('');

const integer = (random: RandomSource, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

export const isLuhnValid = (number: string): boolean => {
  const digitsOnly = number.replace(/\s/g, '');
  if (!/^\d{8,19}$/.test(digitsOnly)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digitsOnly.length - 1; index >= 0; index -= 1) {
    let digit = Number(digitsOnly[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
};

const luhnCheckDigit = (partial: string): number => {
  let sum = 0;
  let doubleDigit = true;
  for (let index = partial.length - 1; index >= 0; index -= 1) {
    let digit = Number(partial[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return (10 - (sum % 10)) % 10;
};

const pickPrefix = (random: RandomSource, spec: NetworkSpec): string => {
  const choice = spec.prefixes[integer(random, 0, spec.prefixes.length - 1)];
  if (typeof choice === 'string') return choice;
  return String(integer(random, choice[0], choice[1]));
};

const groupNumber = (value: string, grouping: number[]): string => {
  const parts: string[] = [];
  let offset = 0;
  for (const size of grouping) {
    parts.push(value.slice(offset, offset + size));
    offset += size;
  }
  return parts.filter(Boolean).join(' ');
};

export const generateSandboxCard = (
  random: RandomSource,
  now: Date
): SandboxCard => {
  const spec = networkSpecs[integer(random, 0, networkSpecs.length - 1)];
  const prefix = pickPrefix(random, spec);
  const body = digits(random, spec.length - prefix.length - 1);
  const partial = `${prefix}${body}`;
  const number = `${partial}${luhnCheckDigit(partial)}`;
  const monthsAhead = integer(random, 24, 60);
  const expiryDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
  const month = String(expiryDate.getUTCMonth() + 1).padStart(2, '0');
  const year = String(expiryDate.getUTCFullYear());
  return {
    network: spec.network,
    number: groupNumber(number, spec.grouping),
    expiry: `${month}/${year}`,
    cvc: digits(random, spec.cvcLength),
    testDataOnly: true
  };
};
