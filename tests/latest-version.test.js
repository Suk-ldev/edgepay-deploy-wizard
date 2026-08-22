import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLatestVersion } from '../src/latest-version-handler.js';

const valid = {
  TEMPLATE_VERSION: '1.1.0',
  TEMPLATE_COMMIT_SHA: 'c381279f251c2f3e0ca08051a4246981e5a196ee',
  TEMPLATE_ENTRY_SHA256: '2d56bff850e1ec853b523e720ab24381770e65affea1af465dd0da3bbf0efd8b',
};

test('公开版本接口返回部署向导锁定的商业发行版本', async () => {
  const response = handleLatestVersion(valid);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    name: 'edgepay-commercial-worker',
    edition: 'public-commercial-encrypted',
    version: '1.1.0',
    commit: valid.TEMPLATE_COMMIT_SHA,
    sha256: valid.TEMPLATE_ENTRY_SHA256,
  });
});

test('版本锁定配置缺失时不返回不完整结果', async () => {
  const response = handleLatestVersion({});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});
