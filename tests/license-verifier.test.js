import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  decodeLicensePayload,
  licenseFetcher,
  normalizePublicBaseUrl,
  verifyLicense,
} from '../src/lib/license-verifier.js';
import { licenseServerUrl } from '../src/lib/license-endpoint.js';

function token(payload) {
  return `EPL1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJl`;
}

async function signedToken(payload) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(encoded))).toString('base64url');
  return {
    token: `EPL1.${encoded}.${signature}`,
    publicKey: Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64'),
  };
}

test('License 校验服务端点以 AES-GCM 密文固定并读取绑定域名', async () => {
  assert.equal(await licenseServerUrl(), 'https://license.imsuk.cn');
  const [verifierSource, endpointSource] = await Promise.all([
    readFile(new URL('../src/lib/license-verifier.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/license-endpoint.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(verifierSource, /license\.imsuk\.cn/u);
  assert.doesNotMatch(endpointSource, /license\.imsuk\.cn/u);
  const decoded = decodeLicensePayload(token({ license_id: 'lic_1', domain: 'pay.example.com' }));
  assert.equal(decoded.domain, 'pay.example.com');
  assert.throws(() => decodeLicensePayload('bad'), /EPL1/u);
});

test('部署环境优先通过 License Worker 服务绑定校验', async () => {
  const calls = [];
  const service = { fetch(url) { calls.push(url); return Response.json({ ok: true }); } };
  const response = await licenseFetcher({ LICENSE_SERVICE: service })('https://license.imsuk.cn/api/v1/health');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['https://license.imsuk.cn/api/v1/health']);
});

test('License 在线校验只向固定服务发送并返回权益', async () => {
  const signed = await signedToken({ license_id: 'lic_1', domain: 'pay.example.com' });
  let requestedUrl = '';
  const result = await verifyLicense(signed.token, async (url, init) => {
    requestedUrl = url;
    const body = JSON.parse(init.body);
    assert.equal(body.domain, 'pay.example.com');
    return Response.json({ license_id: 'lic_1', entitlements: ['alipay_api', 'fubei_receipt'] });
  }, signed.publicKey);
  assert.equal(requestedUrl, 'https://license.imsuk.cn/api/v1/licenses/identify');
  assert.equal(result.domain, 'pay.example.com');
  assert.deepEqual(result.entitlements, ['alipay_api', 'fubei_receipt']);
  const tokenParts = signed.token.split('.');
  const tail = tokenParts[1].slice(-1);
  tokenParts[1] = `${tokenParts[1].slice(0, -1)}${tail === 'A' ? 'B' : 'A'}`;
  const tampered = tokenParts.join('.');
  await assert.rejects(() => verifyLicense(tampered, async () => Response.json({}), signed.publicKey), /签名|内容/u);
});

test('公开访问地址只接受无路径 HTTPS origin', () => {
  assert.equal(normalizePublicBaseUrl('https://pay.example.com/'), 'https://pay.example.com');
  assert.throws(() => normalizePublicBaseUrl('http://pay.example.com'), /HTTPS/u);
  assert.throws(() => normalizePublicBaseUrl('https://pay.example.com/admin'), /无路径/u);
});
