import assert from 'node:assert/strict';
import test from 'node:test';
import { configureWechatMtls, validateWechatMtlsInput } from '../src/lib/cf-mtls.js';

const CERT = `-----BEGIN CERTIFICATE-----\nMIIB0zCCAX2gAwIBAgIJAKZ\n-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----`;

/** 记录所有调用的假 Cloudflare 客户端。settings 是 Worker 当前的绑定列表。 */
function fakeClient({ bindings = [], existingCertificates = [] } = {}) {
  const calls = { get: [], post: [], patch: [] };
  return {
    calls,
    async getJSON(path) {
      calls.get.push(path);
      if (path.includes('/mtls_certificates')) return { result: existingCertificates };
      return { result: { bindings } };
    },
    async postJSON(path, body) {
      calls.post.push({ path, body });
      return { result: { id: 'cert-new', expires_on: '2027-01-01T00:00:00Z' } };
    },
    async patchMultipart(path, form) {
      // 接口只认名为 settings 的 part：用 bindings 会被 10201 拒掉。
      // 断言 part 名是这个用例的重点之一，不要改成宽松匹配。
      assert.equal(form.get('bindings'), null, 'part 不能叫 bindings');
      const blob = form.get('settings');
      assert.ok(blob, 'multipart 必须带名为 settings 的 part');
      const payload = JSON.parse(await blob.text());
      calls.patch.push({ path, payload, bindings: payload.bindings });
      return { result: {} };
    },
  };
}

test('证书和私钥必须成对提供，单独给一个直接报错', () => {
  assert.deepEqual(validateWechatMtlsInput('', ''), { provided: false, certificate: '', privateKey: '' });
  assert.throws(() => validateWechatMtlsInput(CERT, ''), /必须同时上传/u);
  assert.throws(() => validateWechatMtlsInput('', KEY), /必须同时上传/u);
});

test('PEM 格式和体积都要校验，选错文件要说清楚该选哪个', () => {
  assert.throws(() => validateWechatMtlsInput(KEY, KEY), /apiclient_cert\.pem/u);
  assert.throws(() => validateWechatMtlsInput(CERT, CERT), /apiclient_key\.pem/u);
  const huge = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(70 * 1024)}\n-----END CERTIFICATE-----`;
  assert.throws(() => validateWechatMtlsInput(huge, KEY), /过大/u);
});

test('两个文件都没给时不动 Cloudflare，也不报错', async () => {
  const client = fakeClient();
  assert.deepEqual(
    await configureWechatMtls(client, 'account', 'edgepay', { certificate: '', privateKey: '' }),
    { configured: false, provided: false },
  );
  assert.deepEqual(client.calls, { get: [], post: [], patch: [] });
});

test('换绑证书时，原有绑定必须原样保留为 inherit', async () => {
  // 这是这段代码最危险的地方：bindings 是整份替换的。漏掉任何一个已存在的绑定，
  // 对应的 Secret 就被永久抹掉且无法找回（Cloudflare 的 Secret 只写不读）。
  const client = fakeClient({
    bindings: [
      { type: 'd1', name: 'DB', id: 'db-id' },
      { type: 'secret_text', name: 'ADMIN_TOKEN' },
      { type: 'secret_text', name: 'EDGEPAY_LICENSE' },
      { type: 'secret_text', name: 'CONFIG_ENCRYPTION_KEY' },
      { type: 'plain_text', name: 'PUBLIC_BASE_URL', text: 'https://pay.example.com' },
      { type: 'mtls_certificate', name: 'WECHAT_MTLS', id: 'cert-old' },
    ],
  });

  const result = await configureWechatMtls(client, 'account', 'edgepay', { certificate: CERT, privateKey: KEY });

  assert.equal(result.configured, true);
  assert.equal(result.certificateId, 'cert-new');
  assert.equal(result.bindingUpdated, true);
  assert.equal(client.calls.patch.length, 1);

  assert.deepEqual(
    Object.keys(client.calls.patch[0].payload), ['bindings'],
    'settings part 的内容必须是 {"bindings": [...]}',
  );
  const sent = client.calls.patch[0].bindings;
  const byName = new Map(sent.map((binding) => [binding.name, binding]));
  for (const name of ['DB', 'ADMIN_TOKEN', 'EDGEPAY_LICENSE', 'CONFIG_ENCRYPTION_KEY', 'PUBLIC_BASE_URL']) {
    assert.equal(byName.get(name)?.type, 'inherit', `${name} 必须以 inherit 保留，不能从 bindings 里消失`);
  }
  assert.deepEqual(
    byName.get('WECHAT_MTLS'),
    { type: 'mtls_certificate', name: 'WECHAT_MTLS', certificate_id: 'cert-new' },
  );
  // 旧证书不主动删除：它可能还挂在别的 Worker 上。
  assert.equal(client.calls.patch[0].path, '/accounts/account/workers/scripts/edgepay/settings');
});

test('同一张证书重复部署时复用已上传的证书，不重复上传', async () => {
  const client = fakeClient({
    bindings: [{ type: 'd1', name: 'DB', id: 'db-id' }],
    existingCertificates: [{ id: 'cert-existing', expires_on: '2027-06-01T00:00:00Z' }],
  });

  const result = await configureWechatMtls(client, 'account', 'edgepay', { certificate: CERT, privateKey: KEY });

  assert.equal(result.reused, true);
  assert.equal(result.certificateId, 'cert-existing');
  assert.equal(result.expiresAt, '2027-06-01T00:00:00Z');
  assert.equal(client.calls.post.length, 0, '证书已存在就不该再上传一次');
});

test('已经绑着同一张证书时不再发 PATCH', async () => {
  const client = fakeClient({
    bindings: [
      { type: 'd1', name: 'DB', id: 'db-id' },
      { type: 'mtls_certificate', name: 'WECHAT_MTLS', id: 'cert-existing' },
    ],
    existingCertificates: [{ id: 'cert-existing' }],
  });

  const result = await configureWechatMtls(client, 'account', 'edgepay', { certificate: CERT, privateKey: KEY });

  assert.equal(result.configured, true);
  assert.equal(result.bindingUpdated, false);
  assert.equal(client.calls.patch.length, 0);
});

test('Cloudflare 报错时收敛成 wechat_mtls 阶段的部署错误', async () => {
  const client = fakeClient();
  client.postJSON = async () => { throw new Error('SSL and Certificates 权限不足'); };
  await assert.rejects(
    configureWechatMtls(client, 'account', 'edgepay', { certificate: CERT, privateKey: KEY }),
    (error) => {
      assert.equal(error.stage, 'wechat_mtls');
      assert.match(error.message, /权限不足/u);
      return true;
    },
  );
});
