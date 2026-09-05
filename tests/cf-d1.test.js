import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '../src/lib/cf-d1.js';

function d1Rows(results) {
  return { result: [{ results }] };
}

test('没有同名 D1 时创建新数据库', async () => {
  const calls = [];
  const client = {
    async getJSON(path) {
      calls.push(['GET', path]);
      return { result: [] };
    },
    async postJSON(path, body, options) {
      calls.push(['POST', path, body, options]);
      return { result: { uuid: 'db-new' } };
    },
  };

  assert.deepEqual(
    await createDatabase(client, 'account', 'edgepay'),
    { databaseId: 'db-new', reused: false },
  );
  assert.equal(calls.at(-1)[1], '/accounts/account/d1/database');
});

test('同名 D1 没有 EdgePay 表时允许作为失败重试残留复用', async () => {
  const calls = [];
  const client = {
    async getJSON() {
      return { result: [{ name: 'edgepay', uuid: 'db-existing' }] };
    },
    async postJSON(path, body) {
      calls.push({ path, body });
      assert.match(body.sql, /sqlite_master/u);
      return d1Rows([]);
    },
  };

  assert.deepEqual(
    await createDatabase(client, 'account', 'edgepay'),
    { databaseId: 'db-existing', reused: true },
  );
  assert.equal(calls.length, 1);
});

test('同名 D1 有 EdgePay 表但没有数据时允许复用', async () => {
  const queries = [];
  const client = {
    async getJSON() {
      return { result: [{ name: 'edgepay', id: 'db-existing' }] };
    },
    async postJSON(_path, body) {
      queries.push(body.sql);
      if (/sqlite_master/u.test(body.sql)) return d1Rows([{ name: 'runtime_settings' }]);
      return d1Rows([{ table_name: 'runtime_settings', row_count: 0 }]);
    },
  };

  assert.deepEqual(
    await createDatabase(client, 'account', 'edgepay'),
    { databaseId: 'db-existing', reused: true },
  );
  assert.equal(queries.length, 2);
});

test('同名 D1 已有运行数据时阻止新建部署复用旧密文', async () => {
  const client = {
    async getJSON() {
      return { result: [{ name: 'edgepay', uuid: 'db-existing' }] };
    },
    async postJSON(_path, body) {
      if (/sqlite_master/u.test(body.sql)) {
        return d1Rows([{ name: 'runtime_settings' }, { name: 'payment_attempts' }]);
      }
      return d1Rows([
        { table_name: 'runtime_settings', row_count: 3 },
        { table_name: 'payment_attempts', row_count: 0 },
      ]);
    },
  };

  await assert.rejects(
    createDatabase(client, 'account', 'edgepay'),
    (error) => {
      assert.equal(error.stage, 'd1_create');
      assert.equal(error.retryable, false);
      assert.equal(error.action, 'rename_project');
      assert.match(error.message, /已有 EdgePay 数据/u);
      assert.match(error.detail, /runtime_settings/u);
      return true;
    },
  );
});
