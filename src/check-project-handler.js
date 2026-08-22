import { CloudflareClient } from './lib/cf-client.js';
import { DeployError } from './lib/errors.js';
import { inspectWorker } from './lib/cf-worker-state.js';

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/iu;
const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/u;

export async function handleCheckProject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (!body?.cfApiToken || !ACCOUNT_ID_RE.test(String(body.cfAccountId ?? '')) || !PROJECT_NAME_RE.test(String(body.projectName ?? ''))) {
    return Response.json({ ok: false, error: 'Token、Account ID 或项目名格式不对' }, { status: 400 });
  }

  try {
    const state = await inspectWorker(new CloudflareClient(body.cfApiToken), body.cfAccountId, body.projectName);
    return Response.json({ ok: true, exists: state.exists, compatible: state.compatible });
  } catch (error) {
    const message = error instanceof DeployError ? error.message : '检查同名 Worker 失败';
    return Response.json({ ok: false, error: message }, { status: 200 });
  }
}
