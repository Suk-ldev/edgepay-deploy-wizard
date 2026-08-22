import { CloudflareClient } from './lib/cf-client.js';
import { createWorkersDevAccountSubdomain } from './lib/cf-subdomain.js';
import { verifyToken } from './lib/cf-token.js';
import { DeployError, redact } from './lib/errors.js';

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/iu;

export async function handleWorkersSubdomain(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const token = String(body?.cfApiToken ?? '');
  const accountId = String(body?.cfAccountId ?? '');
  if (!token || !ACCOUNT_ID_RE.test(accountId) || !body?.subdomain) {
    return Response.json({ ok: false, error: 'Token、Account ID 和 workers.dev 子域名都要填写' }, { status: 400 });
  }

  try {
    const client = new CloudflareClient(token);
    await verifyToken(client, accountId);
    const subdomain = await createWorkersDevAccountSubdomain(client, accountId, body.subdomain);
    return Response.json({ ok: true, subdomain, url: `https://${subdomain}.workers.dev` });
  } catch (error) {
    const message = error instanceof DeployError ? error.message : '创建 workers.dev 子域名失败';
    return Response.json({ ok: false, error: redact(message, [token]) }, { status: 200 });
  }
}
