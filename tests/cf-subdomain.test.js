import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkersDevAccountSubdomain,
  enableWorkersDevSubdomain,
  getWorkersDevAccountSubdomain,
} from '../src/lib/cf-subdomain.js';
import { DeployError } from '../src/lib/errors.js';

test('读取已经存在的账号 workers.dev 子域名', async () => {
  const client = {
    getJSON: async (path) => {
      assert.equal(path, '/accounts/ACCOUNT/workers/subdomain');
      return { result: { subdomain: 'My-EdgePay' } };
    },
  };
  assert.equal(await getWorkersDevAccountSubdomain(client, 'ACCOUNT'), 'my-edgepay');
});

test('Cloudflare 明确提示尚未开通时返回空值供前端引导', async () => {
  const client = {
    getJSON: async () => {
      throw new DeployError('workers_dev_setup', 'You do not have a workers.dev subdomain. Please open Workers & Pages.');
    },
  };
  assert.equal(await getWorkersDevAccountSubdomain(client, 'ACCOUNT'), null);
});

test('通过账号级 API 创建 workers.dev 子域名', async () => {
  let captured;
  const client = {
    putJSON: async (path, body, options) => {
      captured = { path, body, options };
      return { result: { subdomain: body.subdomain } };
    },
  };
  const subdomain = await createWorkersDevAccountSubdomain(client, 'ACCOUNT', 'EdgePay-A1');
  assert.equal(subdomain, 'edgepay-a1');
  assert.deepEqual(captured, {
    path: '/accounts/ACCOUNT/workers/subdomain',
    body: { subdomain: 'edgepay-a1' },
    options: { stage: 'workers_dev_setup' },
  });
});

test('创建前拦截不合法的账号子域名前缀', async () => {
  await assert.rejects(
    createWorkersDevAccountSubdomain({}, 'ACCOUNT', '-bad-name'),
    /只能使用小写字母/u,
  );
});

test('账号子域名存在后为指定 Worker 开启 workers.dev', async () => {
  const requests = [];
  const client = {
    postJSON: async (path, body) => { requests.push({ path, body }); return { success: true }; },
    getJSON: async () => ({ result: { subdomain: 'edgepay-a1' } }),
  };
  assert.equal(
    await enableWorkersDevSubdomain(client, 'ACCOUNT', 'payment-worker'),
    'https://payment-worker.edgepay-a1.workers.dev',
  );
  assert.deepEqual(requests[0], {
    path: '/accounts/ACCOUNT/workers/scripts/payment-worker/subdomain',
    body: { enabled: true },
  });
});
