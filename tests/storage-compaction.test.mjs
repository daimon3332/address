import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dropRedundantEvidenceIndex, purgeCompletedRecovery } from '../server/sync/storage-compaction.mjs';

describe('storage compaction', () => {
  it('deletes completed recovery rows page by page until none are left', async () => {
    let remaining = 25;
    const statements = [];
    const database = { prepare: (sql) => ({ bind: (limit) => ({ all: async () => {
      statements.push(sql);
      const page = Math.min(limit, remaining);
      remaining -= page;
      return { results: Array.from({ length: page }, (_, index) => ({ address_id: String(index) })) };
    } }) }) };
    expect(await purgeCompletedRecovery({ database, pageSize: 10, pauseMs: 0 })).toBe(25);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain("status='complete'");
  });

  it('drops the evidence index that repeated the primary key and restores the session timeouts', async () => {
    const queries = [];
    const client = { query: async (sql, values) => {
      queries.push([sql, values]);
      return { rows: [{ statement_timeout: '30s', lock_timeout: '5s' }] };
    } };
    await dropRedundantEvidenceIndex(client);
    expect(queries.map(([sql]) => sql)).toContain('DROP INDEX CONCURRENTLY IF EXISTS address.idx_address_pool_evidence_source_record');
    expect(queries.at(-1)[1]).toEqual(['30s', '5s']);
    expect(readFileSync(new URL('../server/database/schema.sql', import.meta.url), 'utf8')).not.toContain('idx_address_pool_evidence_source_record');
  });
});
