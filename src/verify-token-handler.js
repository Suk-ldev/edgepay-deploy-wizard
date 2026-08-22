import { CloudflareClient } from './lib/cf-client.js';
import { verifyToken } from './lib/cf-token.js';
import { DeployError } from './lib/errors.js';
import { getWorkersDevAccountSubdomain } from './lib/cf-subdomain.js';

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

export async function handleVerifyToken(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }), { status: 400 });
  }

  if (!body?.cfApiToken || !body?.cfAccountId || !ACCOUNT_ID_RE.test(body.cfAccountId)) {
    return new Response(JSON.stringify({ ok: false, error: 'Token 和 Account ID 都要填' }), { status: 400 });
  }

  const client = new CloudflareClient(body.cfApiToken);
  try {
    await verifyToken(client, body.cfAccountId);
    const workersDevSubdomain = await getWorkersDevAccountSubdomain(client, body.cfAccountId);
    return Response.json({
      ok: true,
      workersDevConfigured: Boolean(workersDevSubdomain),
      workersDevSubdomain,
    });
  } catch (err) {
    const message = err instanceof DeployError ? err.message : 'Token 校验失败';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
