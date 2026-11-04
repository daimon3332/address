export function* splitSqlStatements(source) {
  let start = 0;
  let quote = '';
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = '';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockCommentDepth) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = '';
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (next === quote) index += 1;
        else quote = '';
      }
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      continue;
    }
    if (character === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (character !== ';') continue;

    const statement = source.slice(start, index).trim();
    if (statement) yield statement;
    start = index + 1;
  }

  const tail = source.slice(start).trim();
  if (tail) yield tail;
}

const beginStatement = /^(BEGIN(\s+(WORK|TRANSACTION))?|START\s+TRANSACTION)$/iu;
const commitStatement = /^(COMMIT|END)(\s+(WORK|TRANSACTION))?$/iu;

// The catalog seed wraps its writes in BEGIN ... COMMIT. The database runs transactions only through transaction(),
// which holds one connection for the block and rolls it back on failure, so the markers open and close that call.
export const executeSqlStatements = async (database, source, onProgress = () => {}) => {
  let completed = 0;
  let block;
  const run = async (target, statement) => {
    await target.exec(statement);
    completed += 1;
    onProgress(completed);
  };
  for (const statement of splitSqlStatements(source)) {
    if (beginStatement.test(statement)) {
      if (block) throw new Error('Nested BEGIN in SQL source');
      block = [];
    } else if (commitStatement.test(statement)) {
      if (!block) throw new Error('COMMIT without BEGIN in SQL source');
      const statements = block;
      block = undefined;
      await database.transaction(async (transaction) => {
        for (const queued of statements) await run(transaction, queued);
      });
    } else if (block) block.push(statement);
    else await run(database, statement);
  }
  if (block) throw new Error('SQL source ends inside a transaction block');
  return completed;
};
