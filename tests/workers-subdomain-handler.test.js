import assert from 'node:assert/strict';
import test from 'node:test';
import { handleVerifyToken } from '../src/verify-token-handler.js';
import { handleWorkersSubdomain } from '../src/workers-subdomain-handler.js';

const ACCOUNT = 'a'.repeat(32);

test('Token 验证阶段识别账号尚未创建 workers.dev', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith(`/accounts/${ACCOUNT}`)) {
      return Response.json({ success: true, result: { id: ACCOUNT } });
    }
    return Response.json({
      success: false,
      errors: [{ message: 'You do not have a workers.dev subdomain.' }],
    }, { status: 400 });
  };
  try {
    const response = await handleVerifyToken(new Request('https://deploy.example/api/verify-token', {
      method: 'POST',
      body: JSON.stringify({ cfApiToken: 'TOKEN_VALUE', cfAccountId: ACCOUNT }),
    }));
    assert.deepEqual(await response.json(), {
      ok: true,
      workersDevConfigured: false,
      workersDevSubdomain: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('开通接口验证账号后使用 PUT 创建账号级子域名', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options.method, body: options.body });
    if (options.method === 'GET') return Response.json({ success: true, result: { id: ACCOUNT } });
    return Response.json({ success: true, result: { subdomain: 'edgepay-a1' } });
  };
  try {
    const response = await handleWorkersSubdomain(new Request('https://deploy.example/api/workers-subdomain', {
      method: 'POST',
      body: JSON.stringify({
        cfApiToken: 'TOKEN_VALUE',
        cfAccountId: ACCOUNT,
        subdomain: 'edgepay-a1',
      }),
    }));
    assert.deepEqual(await response.json(), {
      ok: true,
      subdomain: 'edgepay-a1',
      url: 'https://edgepay-a1.workers.dev',
    });
    assert.equal(requests[1].method, 'PUT');
    assert.equal(requests[1].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`);
    assert.equal(requests[1].body, JSON.stringify({ subdomain: 'edgepay-a1' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
