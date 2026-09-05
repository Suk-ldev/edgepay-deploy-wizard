import assert from 'node:assert/strict';
import test from 'node:test';
import { DeployError } from '../src/lib/errors.js';
import { CERTIFICATE_PERMISSION_HINT, probeCertificatePermission } from '../src/lib/cf-token.js';

/**
 * 只有 D1 + Workers 权限是最常见的 Token 配法。那时候把微信证书上传框摆出来，
 * 用户填完要一路走到部署最后一步才被 Cloudflare 拒掉，白填。
 */
function client({ getStatus = null, postStatus = null } = {}) {
  const calls = [];
  const fail = (status) => {
    throw new DeployError('verify_token', 'cf error', { status });
  };
  return {
    calls,
    async getJSON(path) {
      calls.push(['GET', path]);
      if (getStatus) fail(getStatus);
      return { result: [] };
    },
    async postJSON(path, body) {
      calls.push(['POST', path, body]);
      if (postStatus) fail(postStatus);
      return { result: {} };
    },
  };
}

test('列表就 403 说明 Token 完全没有 SSL 和证书权限', async () => {
  const cf = client({ getStatus: 403 });
  assert.deepEqual(await probeCertificatePermission(cf, 'acc'), { access: 'denied', reason: 'missing' });
  assert.equal(cf.calls.length, 1, '读都读不到就不用再试写了');
  assert.match(CERTIFICATE_PERMISSION_HINT.missing, /SSL 和证书/u);
});

test('读得到但写被拒，说明只给了只读权限', async () => {
  const cf = client({ postStatus: 403 });
  assert.deepEqual(await probeCertificatePermission(cf, 'acc'), { access: 'denied', reason: 'readonly' });
  assert.match(CERTIFICATE_PERMISSION_HINT.readonly, /编辑/u);
});

test('写探测拿到参数校验错误，说明写权限在', async () => {
  // Cloudflare 先鉴权再校验 body，所以 400 是"有权限、只是这次 body 不合法"。
  const cf = client({ postStatus: 400 });
  assert.deepEqual(await probeCertificatePermission(cf, 'acc'), { access: 'allowed', reason: 'writable' });

  const probe = cf.calls.find(([method]) => method === 'POST');
  assert.deepEqual(probe[2], {}, '写探测必须发一个建不出证书的空 body');
  assert.match(probe[1], /\/accounts\/acc\/mtls_certificates$/u);
});

test('探测本身出意外时放行，不因为一次网络抖动把功能藏起来', async () => {
  assert.deepEqual(
    await probeCertificatePermission(client({ getStatus: 500 }), 'acc'),
    { access: 'unknown', reason: 'probe_failed' },
  );
  assert.deepEqual(
    await probeCertificatePermission(client({ postStatus: 502 }), 'acc'),
    { access: 'unknown', reason: 'probe_failed' },
  );
});
