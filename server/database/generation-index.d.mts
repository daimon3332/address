import type { Database } from './database.mjs';

export function addressPublicationSqlClause(prefix?: string): string;
export function addressLocalizationSqlClause(prefix?: string): string;
export function generationIndexRowCount(database: Database): Promise<number>;
export function ranksNeedRenumbering(maximum: unknown, total: unknown): boolean;
export function refreshAddressGenerationIndex(database: Database, countryCode: string, options?: { addressIds?: string[] }): Promise<number>;
export function refreshStaleAddressGenerationIndexes(database: Database): Promise<string[]>;
export function refreshAddressGenerationIndexIfEmpty(database: Database, countryCodes: string[]): Promise<boolean>;
