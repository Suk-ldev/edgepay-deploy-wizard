import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScriptMetadata } from '../src/lib/cf-worker-script.js';

test('metadata 只包含 D1、明文变量和密钥，不创建 KV/Assets 绑定', () => {
  const metadata = buildScriptMetadata({
    databaseId: 'db-123',
    secrets: { ADMIN_TOKEN: 'secret-a', EPAY_KEY: 'secret-b' },
    vars: { PUBLIC_BASE_URL: 'https://x.workers.dev', EPAY_PID: '1000' },
  });

  assert.equal(metadata.main_module, 'index.js');
  assert.deepEqual(metadata.triggers, { crons: ['* * * * *'] });

  const byName = Object.fromEntries(metadata.bindings.map((b) => [b.name, b]));

  assert.equal(byName.DB.type, 'd1');
  assert.equal(byName.DB.id, 'db-123');

  assert.equal(byName.PUBLIC_BASE_URL.type, 'plain_text');
  assert.equal(byName.PUBLIC_BASE_URL.text, 'https://x.workers.dev');
  assert.equal(byName.EPAY_PID.type, 'plain_text');

  assert.equal(byName.ADMIN_TOKEN.type, 'secret_text');
  assert.equal(byName.ADMIN_TOKEN.text, 'secret-a');
  assert.equal(byName.EPAY_KEY.type, 'secret_text');

  assert.equal(byName.ASSETS, undefined);
  assert.equal('assets' in metadata, false);
});

test('compatibility_date 是当天的 YYYY-MM-DD', () => {
  const metadata = buildScriptMetadata({ databaseId: 'x', secrets: {}, vars: {} });
  assert.match(metadata.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('secret 和 plain_text 不会互相混淆成同一种类型', () => {
  const metadata = buildScriptMetadata({
    databaseId: 'x',
    secrets: { A: '1' },
    vars: { A: '2' },
  });
  const typesForA = metadata.bindings.filter((b) => b.name === 'A').map((b) => b.type);
  assert.deepEqual(typesForA.sort(), ['plain_text', 'secret_text']);
});
