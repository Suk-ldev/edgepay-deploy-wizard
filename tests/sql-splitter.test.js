import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { splitStatements } from '../src/lib/sql-splitter.js';

test('拆分真实 schema.sql，得到 14 条独立语句', async () => {
  const sql = await readFile(new URL('./fixtures/schema.sql', import.meta.url), 'utf8');
  const statements = splitStatements(sql);

  assert.equal(statements.length, 14);
  for (const stmt of statements) {
    const withoutLeadingComments = stmt.replace(/^(\s*--[^\n]*\n)+/, '').trimStart();
    assert.match(withoutLeadingComments, /^(PRAGMA|CREATE)\b/i);
    assert.ok(!stmt.includes(';'), `语句里不应该残留分号: ${stmt.slice(0, 40)}`);
  }
});

test('忽略行注释里的分号', () => {
  const sql = "CREATE TABLE a (id INTEGER); -- comment; with fake ; separators\nCREATE TABLE b (id INTEGER);";
  const statements = splitStatements(sql);
  assert.equal(statements.length, 2);
});

test('忽略字符串字面量里的分号', () => {
  const sql = "INSERT INTO a (name) VALUES ('semi;colon'); CREATE TABLE b (id INTEGER);";
  const statements = splitStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /'semi;colon'/);
});

test('空输入返回空数组', () => {
  assert.deepEqual(splitStatements(''), []);
  assert.deepEqual(splitStatements('   \n  '), []);
});

test('没有结尾分号的最后一条语句也会被保留', () => {
  const statements = splitStatements('CREATE TABLE a (id INTEGER)');
  assert.equal(statements.length, 1);
});
