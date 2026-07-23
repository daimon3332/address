export type SqliteValue = null | number | bigint | string | Uint8Array;

export interface SqliteResult<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: {
    duration: number;
    changes: number;
    last_row_id: number;
    rows_read: number;
    rows_written: number;
  };
}

export interface SqlitePreparedStatement {
  bind(...values: unknown[]): SqlitePreparedStatement;
  all<T = Record<string, unknown>>(): Promise<SqliteResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(columnName: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<SqliteResult<T>>;
  raw<T extends unknown[] = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export declare class SqliteDatabase {
  constructor(database: unknown, optimizeOnClose?: boolean);
  prepare(query: string): SqlitePreparedStatement;
  batch<T = Record<string, unknown>>(statements: SqlitePreparedStatement[]): Promise<Array<SqliteResult<T>>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  close(): void;
}

export interface OpenDatabaseOptions {
  readOnly?: boolean;
  timeout?: number;
  migrate?: boolean;
}

export declare const openDatabase: (filename: string, options?: OpenDatabaseOptions) => SqliteDatabase;
export declare const openSqliteDatabase: typeof openDatabase;
export declare const initializeSqliteDatabase: (database: SqliteDatabase, source?: URL | string) => Promise<SqliteDatabase>;
