import assert from 'node:assert/strict';
import test from 'node:test';
import { DeployError } from '../src/lib/errors.js';
import { inspectWorker } from '../src/lib/cf-worker-state.js';

test('同名 EdgePay Worker 会识别原 D1 和必要配置', async () => {
  const client = {
    async getJSON(path) {
      assert.equal(path, '/accounts/account/workers/scripts/edgepay/settings');
      return { result: { bindings: [
        { type: 'd1', name: 'DB', id: 'db-id' },
        { type: 'secret_text', name: 'ADMIN_TOKEN' },
        { type: 'secret_text', name: 'EDGEPAY_LICENSE' },
        { type: 'secret_text', name: 'CONFIG_ENCRYPTION_KEY' },
        { type: 'plain_text', name: 'PUBLIC_BASE_URL', text: 'https://pay.example.com' },
      ] } };
    },
  };
  const state = await inspectWorker(client, 'account', 'edgepay');
  assert.equal(state.exists, true);
  assert.equal(state.compatible, true);
  assert.equal(state.databaseId, 'db-id');
});

test('Cloudflare 返回 404 表示项目名未占用', async () => {
  const client = {
    async getJSON() {
      throw new DeployError('project_check', 'not found', { status: 404 });
    },
  };
  assert.deepEqual(await inspectWorker(client, 'account', 'new-name'), {
    exists: false,
    compatible: false,
    databaseId: '',
  });
});

test('同名但缺少 EdgePay 必要绑定时禁止无损升级', async () => {
  const client = {
    async getJSON() {
      return { result: { bindings: [{ type: 'plain_text', name: 'OTHER', text: 'value' }] } };
    },
  };
  const state = await inspectWorker(client, 'account', 'other');
  assert.equal(state.exists, true);
  assert.equal(state.compatible, false);
  assert.equal(state.databaseId, '');
});
