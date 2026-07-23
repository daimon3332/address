const nextSyncAt = (lastSuccessfulAt, intervalDays) => {
  if (!lastSuccessfulAt) return null;
  const date = new Date(lastSuccessfulAt);
  date.setUTCDate(date.getUTCDate() + intervalDays);
  return date.toISOString();
};

export class SqliteCountryStateStore {
  constructor({ database, shards, now = () => new Date() }) {
    this.database = database;
    this.shards = shards;
    this.now = now;
    this.byCountry = new Map(shards.map((shard) => [shard.countryCode, shard]));
    this.byId = new Map(shards.map((shard) => [shard.id, shard]));
  }

  async load() {
    await this.database.batch(this.shards.map((shard) => this.database.prepare(`
      INSERT OR IGNORE INTO sync_country_state(country_code, status, failure_count, updated_at)
      VALUES (?, 'pending', 0, ?)
    `).bind(shard.countryCode, this.now().toISOString())));
    const result = await this.database.prepare(`
      SELECT country_code, status, last_success_at, next_sync_at, active_dataset_id,
        address_count, residential_count, failure_count, last_error, updated_at
      FROM sync_country_state
    `).all();
    const shards = {};
    for (const row of result.results) {
      const shard = this.byCountry.get(row.country_code);
      if (!shard) continue;
      shards[shard.id] = {
        shardId: shard.id,
        countryCode: row.country_code,
        status: row.status === 'ready' ? 'imported' : row.status,
        lastSuccessfulAt: row.last_success_at,
        nextSyncAt: row.next_sync_at,
        datasetId: row.active_dataset_id,
        acceptedCount: Number(row.address_count || 0),
        residentialCount: Number(row.residential_count || 0),
        failureCount: Number(row.failure_count || 0),
        error: row.last_error,
        lastChecked: row.updated_at
      };
    }
    return { schemaVersion: 1, shards };
  }

  async save(state) {
    const statements = [];
    for (const [shardId, entry] of Object.entries(state.shards || {})) {
      const shard = this.byId.get(shardId);
      if (!shard || !['failed', 'imported', 'unchanged'].includes(entry.status)) continue;
      const success = entry.status !== 'failed';
      const lastSuccessfulAt = entry.lastSuccessfulAt || null;
      const updatedAt = entry.lastChecked || lastSuccessfulAt || state.updatedAt || this.now().toISOString();
      statements.push(this.database.prepare(`
        INSERT INTO sync_country_state(
          country_code, status, last_success_at, next_sync_at, active_dataset_id,
          address_count, residential_count, failure_count, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(country_code) DO UPDATE SET
          status=excluded.status,
          last_success_at=coalesce(excluded.last_success_at, sync_country_state.last_success_at),
          next_sync_at=coalesce(excluded.next_sync_at, sync_country_state.next_sync_at),
          active_dataset_id=coalesce(excluded.active_dataset_id, sync_country_state.active_dataset_id),
          address_count=CASE WHEN excluded.status='ready' THEN excluded.address_count ELSE sync_country_state.address_count END,
          residential_count=CASE WHEN excluded.status='ready' THEN excluded.residential_count ELSE sync_country_state.residential_count END,
          failure_count=CASE
            WHEN excluded.status='ready' THEN 0
            WHEN excluded.updated_at<>sync_country_state.updated_at THEN sync_country_state.failure_count+1
            ELSE sync_country_state.failure_count
          END,
          last_error=excluded.last_error,
          updated_at=excluded.updated_at
      `).bind(
        shard.countryCode,
        success ? 'ready' : 'failed',
        lastSuccessfulAt,
        nextSyncAt(lastSuccessfulAt, entry.intervalDays || shard.intervalDays),
        entry.datasetId || null,
        Number(entry.acceptedCount || 0),
        Number(entry.residentialCount || 0),
        success ? 0 : 1,
        success ? null : String(entry.error || 'Address sync failed').slice(0, 1000),
        updatedAt
      ));
    }
    if (statements.length) await this.database.batch(statements);
  }
}
