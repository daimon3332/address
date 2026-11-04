import { describe, expect, it, vi } from 'vitest';
import { executeSqlStatements, splitSqlStatements } from '../scripts/sql-statements.mjs';

describe('catalog SQL statement execution', () => {
  it('splits statements without breaking quoted values or comments', () => {
    const source = `BEGIN;
      INSERT INTO examples(value) VALUES ('a; b'), ('it''s; valid');
      -- ignored ; delimiter
      /* nested ; /* still ignored ; */ done */
      DO $body$ BEGIN PERFORM ';'; END $body$;
      COMMIT;`;

    expect([...splitSqlStatements(source)]).toEqual([
      'BEGIN',
      "INSERT INTO examples(value) VALUES ('a; b'), ('it''s; valid')",
      "-- ignored ; delimiter\n      /* nested ; /* still ignored ; */ done */\n      DO $body$ BEGIN PERFORM ';'; END $body$",
      'COMMIT'
    ]);
  });

  it('runs a BEGIN ... COMMIT block through one database transaction', async () => {
    const calls = [];
    const database = {
      exec: vi.fn(async (statement) => { calls.push(['database', statement]); }),
      transaction: vi.fn(async (work) => {
        calls.push(['begin']);
        await work({ exec: async (statement) => { calls.push(['transaction', statement]); } });
        calls.push(['commit']);
      })
    };
    const completed = await executeSqlStatements(database, 'SELECT 0; BEGIN; SELECT 1; SELECT 2; COMMIT; SELECT 3;');

    expect(completed).toBe(4);
    expect(calls).toEqual([
      ['database', 'SELECT 0'], ['begin'], ['transaction', 'SELECT 1'], ['transaction', 'SELECT 2'], ['commit'],
      ['database', 'SELECT 3']
    ]);
  });

  it('never sends transaction control statements to exec, which PostgreSQL rejects outside transaction()', async () => {
    const exec = vi.fn(async (statement) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|END)(\s+TRANSACTION)?\s*;?$/iu.test(statement)) throw new Error('Use database.transaction() for PostgreSQL transactions');
    });
    const database = { exec, transaction: async (work) => work({ exec }) };

    await expect(executeSqlStatements(database, 'BEGIN TRANSACTION; SELECT 1; END;')).resolves.toBe(1);
    expect(exec.mock.calls.map(([statement]) => statement)).toEqual(['SELECT 1']);
  });

  it('fails the transaction when a statement in the block fails', async () => {
    const executed = [];
    let rolledBack = false;
    const database = {
      transaction: async (work) => {
        try { return await work({ exec: async (statement) => {
          if (statement === 'SELECT broken') throw new Error('failed');
          executed.push(statement);
        } }); } catch (error) { rolledBack = true; throw error; }
      }
    };

    await expect(executeSqlStatements(database, 'BEGIN; SELECT 1; SELECT broken; SELECT 2; COMMIT;')).rejects.toThrow('failed');
    expect(executed).toEqual(['SELECT 1']);
    expect(rolledBack).toBe(true);
  });

  it('rejects an unterminated transaction block', async () => {
    const database = { exec: vi.fn(), transaction: vi.fn() };
    await expect(executeSqlStatements(database, 'BEGIN; SELECT 1;')).rejects.toThrow('ends inside a transaction block');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
