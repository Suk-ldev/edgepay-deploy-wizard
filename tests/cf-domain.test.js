import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureWorkerCustomDomain } from '../src/lib/cf-domain.js';

test('已有相同 Worker 自定义域名时直接复用', async () => {
  const client = {
    getJSON: async (path, options) => {
      assert.equal(path, '/accounts/ACCOUNT/workers/domains?hostname=pay.example.com');
      assert.deepEqual(options, { stage: 'bind_domain' });
      return { result: [{ id: 'domain-1', hostname: 'pay.example.com', service: 'edgepay' }] };
    },
  };
  assert.deepEqual(
    await ensureWorkerCustomDomain(client, 'ACCOUNT', 'edgepay', 'PAY.EXAMPLE.COM'),
    { hostname: 'pay.example.com', reused: true, id: 'domain-1' },
  );
});

test('License 域名未绑定时直接绑定到支付 Worker', async () => {
  const requests = [];
  const client = {
    getJSON: async () => ({ result: [] }),
    putJSON: async (path, body, options) => {
      requests.push({ path, body, options });
      return { result: { id: 'domain-2', hostname: body.hostname, service: body.service } };
    },
  };
  assert.deepEqual(
    await ensureWorkerCustomDomain(client, 'ACCOUNT', 'edgepay', 'pay.example.com'),
    { hostname: 'pay.example.com', reused: false, id: 'domain-2' },
  );
  assert.deepEqual(requests[0], {
    path: '/accounts/ACCOUNT/workers/domains',
    body: { hostname: 'pay.example.com', service: 'edgepay' },
    options: { stage: 'bind_domain' },
  });
});

test('域名已属于其他 Worker 时停止部署且不改原绑定', async () => {
  const client = {
    getJSON: async () => ({ result: [{ hostname: 'pay.example.com', service: 'other-worker' }] }),
  };
  await assert.rejects(
    ensureWorkerCustomDomain(client, 'ACCOUNT', 'edgepay', 'pay.example.com'),
    /已绑定到另一个 Worker/u,
  );
});

test('绑定前拦截无效域名', async () => {
  await assert.rejects(
    ensureWorkerCustomDomain({}, 'ACCOUNT', 'edgepay', 'localhost'),
    /域名格式不正确/u,
  );
});
