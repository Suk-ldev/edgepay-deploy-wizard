import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LICENSE_SERVER_URL,
  decodeLicensePayload,
  normalizePublicBaseUrl,
  verifyLicense,
} from '../src/lib/license-verifier.js';

function token(payload) {
  return `EPL1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJl`;
}

test('License 校验服务固定为 license.imsuk.cn 并读取绑定域名', () => {
  assert.equal(LICENSE_SERVER_URL, 'https://license.imsuk.cn');
  const decoded = decodeLicensePayload(token({ license_id: 'lic_1', domain: 'pay.example.com' }));
  assert.equal(decoded.domain, 'pay.example.com');
  assert.throws(() => decodeLicensePayload('bad'), /EPL1/u);
});

test('License 在线校验只向固定服务发送并返回权益', async () => {
  let requestedUrl = '';
  const result = await verifyLicense(token({ license_id: 'lic_1', domain: 'pay.example.com' }), async (url, init) => {
    requestedUrl = url;
    const body = JSON.parse(init.body);
    assert.equal(body.domain, 'pay.example.com');
    return Response.json({ license_id: 'lic_1', entitlements: ['alipay_api', 'fubei_receipt'] });
  });
  assert.equal(requestedUrl, 'https://license.imsuk.cn/api/v1/licenses/identify');
  assert.equal(result.domain, 'pay.example.com');
  assert.deepEqual(result.entitlements, ['alipay_api', 'fubei_receipt']);
});

test('公开访问地址只接受无路径 HTTPS origin', () => {
  assert.equal(normalizePublicBaseUrl('https://pay.example.com/'), 'https://pay.example.com');
  assert.throws(() => normalizePublicBaseUrl('http://pay.example.com'), /HTTPS/u);
  assert.throws(() => normalizePublicBaseUrl('https://pay.example.com/admin'), /无路径/u);
});
