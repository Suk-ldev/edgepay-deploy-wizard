import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLatestVersion } from '../src/latest-version-handler.js';

const valid = {
  TEMPLATE_VERSION: '1.2.1',
  TEMPLATE_COMMIT_SHA: 'e77de435b6e6e9396b6962afc073386fa4bf8f1a',
  TEMPLATE_ENTRY_SHA256: '9c1e54828c9c86d340ec0b2357b8842324fa1845531218625a8239df9d9a8203',
};

test('公开版本接口返回部署向导锁定的商业发行版本', async () => {
  const response = handleLatestVersion(valid);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    name: 'edgepay-commercial-worker',
    edition: 'public-commercial-encrypted',
    version: '1.2.1',
    commit: valid.TEMPLATE_COMMIT_SHA,
    sha256: valid.TEMPLATE_ENTRY_SHA256,
  });
});

test('版本锁定配置缺失时不返回不完整结果', async () => {
  const response = handleLatestVersion({});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});
