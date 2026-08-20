import { DeployError } from './lib/errors.js';
import { verifyLicense } from './lib/license-verifier.js';

export async function handleVerifyLicense(request) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }
  try {
    const result = await verifyLicense(body?.license);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof DeployError && error.retryable ? 503 : 400;
    return Response.json({ ok: false, error: String(error?.message ?? 'License 校验失败') }, { status });
  }
}
