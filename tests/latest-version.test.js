import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLatestVersion } from '../src/latest-version-handler.js';

const valid = {
  TEMPLATE_VERSION: '1.1.1',
  TEMPLATE_COMMIT_SHA: '477f86492b9133d2f247f25e97957e1330c4e4d1',
  TEMPLATE_ENTRY_SHA256: 'a4b77b4c480855061b843a65377e042901fc8d44b1a1060587c7f44e7dd5f867',
};

test('公开版本接口返回部署向导锁定的商业发行版本', async () => {
  const response = handleLatestVersion(valid);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    name: 'edgepay-commercial-worker',
    edition: 'public-commercial-encrypted',
    version: '1.1.1',
    commit: valid.TEMPLATE_COMMIT_SHA,
    sha256: valid.TEMPLATE_ENTRY_SHA256,
  });
});

test('版本锁定配置缺失时不返回不完整结果', async () => {
  const response = handleLatestVersion({});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});
