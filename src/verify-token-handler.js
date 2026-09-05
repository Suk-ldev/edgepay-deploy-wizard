import { CloudflareClient } from './lib/cf-client.js';
import { readBoundedJson } from './body-limits.js';
import { CERTIFICATE_PERMISSION_HINT, probeCertificatePermission, verifyToken } from './lib/cf-token.js';
import { DeployError } from './lib/errors.js';

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

export async function handleVerifyToken(request) {
  let body;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error.message ?? '请求体不是合法 JSON') }), {
      status: Number(error.status) || 400,
    });
  }

  if (!body?.cfApiToken || !body?.cfAccountId || !ACCOUNT_ID_RE.test(body.cfAccountId)) {
    return new Response(JSON.stringify({ ok: false, error: 'Token 和 Account ID 都要填' }), { status: 400 });
  }

  const client = new CloudflareClient(body.cfApiToken);
  try {
    await verifyToken(client, body.cfAccountId);
    // 证书权限只影响一个可选功能，探测失败不该拖垮整个 Token 验证。
    let certificates = { access: 'unknown', reason: 'probe_failed' };
    try {
      certificates = await probeCertificatePermission(client, body.cfAccountId);
    } catch { /* 保持 unknown：放行，让部署阶段给出真实错误 */ }
    return Response.json({
      ok: true,
      certificates: certificates.access,
      certificatesHint: CERTIFICATE_PERMISSION_HINT[certificates.reason] ?? '',
    });
  } catch (err) {
    const message = err instanceof DeployError ? err.message : 'Token 校验失败';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
