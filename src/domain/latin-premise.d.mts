export const foreignScript: RegExp;
export function transliterateRussian(value: string): string;
export function kanjiNumber(value: string): number | undefined;
export function japanEnglishHouseNumber(value: string): string | undefined;
export function latinPremise(countryCode: string, field: 'houseNumber' | 'unit', value: unknown): string | undefined;
export function chinesePremise(countryCode: string, field: 'houseNumber' | 'unit', value: unknown): string | undefined;
