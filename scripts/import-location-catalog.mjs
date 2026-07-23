import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../server/database/sqlite.mjs';

const databasePath = resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite');
const input = resolve(process.argv[2] || '.data-cache/catalog-seed.sql');
const database = openDatabase(databasePath);

try {
  await database.exec(readFileSync(input, 'utf8'));
  const counts = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM catalog_regions) AS regions,
    (SELECT COUNT(*) FROM catalog_cities) AS cities,
    (SELECT COUNT(*) FROM catalog_postcodes) AS postcodes`).first();
  console.log(JSON.stringify({ database: databasePath, input, ...counts }));
} finally {
  database.close();
}
