import { resolve } from 'node:path';
import { openDatabase } from './sqlite.mjs';

const configuredPath = process.env.ADDRESS_DATABASE_PATH || process.argv[2] || 'data/address.sqlite';
const filename = configuredPath === ':memory:' ? configuredPath : resolve(configuredPath);
const database = openDatabase(filename);

try {
  const version = await database.prepare('SELECT MAX(version) AS version FROM schema_migrations').first('version');
  console.log(JSON.stringify({ database: filename, schemaVersion: version }));
} finally {
  database.close();
}
