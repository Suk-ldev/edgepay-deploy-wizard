import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLatestVersion } from '../src/latest-version-handler.js';

const valid = {
  TEMPLATE_VERSION: '1.0.2',
  TEMPLATE_COMMIT_SHA: 'f2f5180564c2506842709791250aced7cae182d8',
  TEMPLATE_ENTRY_SHA256: '8be2ddd8adc9e57d9dd2b0f757ccfd7ff831ae9bcd0bbc937bb245c08e570bb9',
};

test('公开版本接口返回部署向导锁定的商业发行版本', async () => {
  const response = handleLatestVersion(valid);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    name: 'edgepay-commercial-worker',
    edition: 'public-commercial-encrypted',
    version: '1.0.2',
    commit: valid.TEMPLATE_COMMIT_SHA,
    sha256: valid.TEMPLATE_ENTRY_SHA256,
  });
});

test('版本锁定配置缺失时不返回不完整结果', async () => {
  const response = handleLatestVersion({});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});
