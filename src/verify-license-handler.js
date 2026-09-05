import { DeployError } from './lib/errors.js';
import { readBoundedJson } from './body-limits.js';
import { licenseFetcher, verifyLicense } from './lib/license-verifier.js';

export async function handleVerifyLicense(request, env) {
  let body;
  try { body = await readBoundedJson(request); } catch (error) {
    return Response.json({ ok: false, error: String(error.message ?? '请求体不是合法 JSON') }, {
      status: Number(error.status) || 400,
    });
  }
  try {
    const result = await verifyLicense(body?.license, licenseFetcher(env));
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof DeployError && error.retryable ? 503 : 400;
    return Response.json({ ok: false, error: String(error?.message ?? 'License 校验失败') }, { status });
  }
}
