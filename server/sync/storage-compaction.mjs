const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

// Finished translations used to keep their translation_recovery row: most of the table, read by nothing. They are
// deleted in pages beside the other startup steps; a translation that completes now deletes its row at once.
export const purgeCompletedRecovery = async ({ database, pageSize = 10_000, pauseMs = 100 }) => {
  let deleted = 0;
  for (;;) {
    const rows = (await database.prepare(`DELETE FROM translation_recovery WHERE address_id IN (
        SELECT address_id FROM translation_recovery WHERE status='complete' LIMIT ?)
      RETURNING address_id`).bind(pageSize).all()).results;
    // A short page is not the end: the backfill may have removed one of the selected rows first.
    if (!rows.length) return deleted;
    deleted += rows.length;
    await delay(pauseMs);
  }
};

// An evidence id is the hash of its dataset, address, source record and type, so this unique index (the largest on
// the table) only repeated the primary key. Dropped concurrently, outside the deploy migration.
export const dropRedundantEvidenceIndex = async (client) => {
  const settings = (await client.query("SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0];
  try {
    await client.query("SET statement_timeout TO '60min'");
    await client.query("SET lock_timeout TO '0'");
    await client.query('DROP INDEX CONCURRENTLY IF EXISTS address.idx_address_pool_evidence_source_record');
  } finally {
    await client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",
      [settings.statement_timeout, settings.lock_timeout]);
  }
};
