import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const schemaUrl = new URL('./schema.sql', import.meta.url);

const normalizeBinding = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
};

const plainRow = (row) => row == null ? row : { ...row };

class SqlitePreparedStatement {
  #statementFor;
  #query;
  #bindings;

  constructor(statementFor, query, bindings = []) {
    this.#statementFor = statementFor;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values) {
    return new SqlitePreparedStatement(this.#statementFor, this.#query, values.map(normalizeBinding));
  }

  _execute() {
    const startedAt = performance.now();
    const statement = this.#statementFor(this.#query);
    const returnsRows = statement.columns().length > 0;
    const rows = statement.all(...this.#bindings).map(plainRow);
    const writeMeta = returnsRows
      ? { changes: 0, lastInsertRowid: 0 }
      : plainRow(this.#statementFor('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').get());
    return {
      success: true,
      results: rows,
      meta: {
        duration: performance.now() - startedAt,
        changes: Number(writeMeta?.changes || 0),
        last_row_id: Number(writeMeta?.lastInsertRowid || 0),
        rows_read: returnsRows ? rows.length : 0,
        rows_written: returnsRows ? 0 : Number(writeMeta?.changes || 0)
      }
    };
  }

  async all() {
    return this._execute();
  }

  async first(columnName) {
    const statement = this.#statementFor(this.#query);
    const row = plainRow(statement.get(...this.#bindings));
    if (row === undefined || columnName === undefined) return row ?? null;
    return Object.hasOwn(row, columnName) ? row[columnName] : null;
  }

  async run() {
    return this._execute();
  }

  async raw(options = {}) {
    const statement = this.#statementFor(this.#query);
    const columns = statement.columns().map(({ name }) => name);
    const rows = statement.all(...this.#bindings).map((row) => columns.map((column) => row[column]));
    return options.columnNames ? [columns, ...rows] : rows;
  }
}

export class SqliteDatabase {
  #database;
  #optimizeOnClose;
  #statements = new Map();

  constructor(database, optimizeOnClose = true) {
    this.#database = database;
    this.#optimizeOnClose = optimizeOnClose;
  }

  prepare(query) {
    return new SqlitePreparedStatement((sql) => this.#statement(sql), query);
  }

  #statement(query) {
    let statement = this.#statements.get(query);
    if (!statement) {
      statement = this.#database.prepare(query);
      this.#statements.set(query, statement);
    }
    return statement;
  }

  async batch(statements) {
    const savepoint = `sqlite_batch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.#database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const results = statements.map((statement) => statement._execute());
      this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return results;
    } catch (error) {
      this.#database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  async exec(query) {
    const startedAt = performance.now();
    this.#database.exec(query);
    return { count: 1, duration: performance.now() - startedAt };
  }

  close() {
    if (!this.#database.isOpen) return;
    if (this.#optimizeOnClose) this.#database.exec('PRAGMA optimize');
    this.#statements.clear();
    this.#database.close();
  }
}

export const openDatabase = (filename, options = {}) => {
  const timeout = Math.max(0, Math.trunc(options.timeout ?? 5_000));
  if (filename !== ':memory:' && !options.readOnly) mkdirSync(dirname(filename), { recursive: true });
  const nativeDatabase = new DatabaseSync(filename, {
    readOnly: options.readOnly === true,
    timeout
  });
  nativeDatabase.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${timeout};`);
  if (!options.readOnly) nativeDatabase.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  if (!options.readOnly && options.migrate !== false) nativeDatabase.exec(readFileSync(fileURLToPath(schemaUrl), 'utf8'));
  return new SqliteDatabase(nativeDatabase, !options.readOnly);
};

export const openSqliteDatabase = openDatabase;

export const initializeSqliteDatabase = async (database, source = schemaUrl) => {
  const path = source instanceof URL ? fileURLToPath(source) : source;
  await database.exec(readFileSync(path, 'utf8'));
  return database;
};
