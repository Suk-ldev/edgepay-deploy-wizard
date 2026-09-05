import { DeployError } from './errors.js';

export async function verifyToken(client, accountId) {
  try {
    // /accounts/{id} 是一个最轻量的读接口：token 无效或没有这个账号的权限都会在这一步报错，
    // 不需要额外的 /user/tokens/verify 调用（那个接口验证的是 token 本身有效，但不保证对
    // 这个具体 account 有权限，而我们真正关心的是"能不能操作这个账号"）。
    await client.getJSON(`/accounts/${accountId}`, { stage: 'verify_token' });
  } catch (err) {
    if (err instanceof DeployError) {
      throw new DeployError('verify_token', 'Token 无效，或者没有这个 Account ID 的访问权限', {
        retryable: false,
        detail: err.detail,
      });
    }
    throw err;
  }
}

/**
 * 这个 Token 能不能管理账号级 mTLS 证书（微信退款证书要用）。
 *
 * 只有 D1 和 Workers 权限的 Token 是最常见的情况——那时候把证书上传框摆出来，
 * 用户填完一路走到部署最后一步才被拒，白填。所以在第一步验证 Token 时就问清楚。
 *
 * 返回 'allowed' | 'denied' | 'unknown'。判断不了的时候一律放行：
 * 宁可让部署阶段给出真实错误，也不要因为一次网络抖动就把功能藏起来。
 */
export async function probeCertificatePermission(client, accountId) {
  try {
    await client.getJSON(`/accounts/${accountId}/mtls_certificates?ca=false&per_page=1`, { stage: 'verify_token' });
  } catch (error) {
    const status = error instanceof DeployError ? error.status : undefined;
    // 读都读不到就是完全没有 SSL and Certificates 权限。
    if (status === 401 || status === 403) return { access: 'denied', reason: 'missing' };
    return { access: 'unknown', reason: 'probe_failed' };
  }

  try {
    // 读得到不代表写得了：Edit 和 Read 是两个权限。这里故意发一个 body 必然过不了
    // 参数校验的创建请求——没有 certificates 字段，创建不出任何东西。
    // Cloudflare 是先鉴权再校验 body 的，所以能走到"参数错误"就说明写权限在。
    await client.postJSON(`/accounts/${accountId}/mtls_certificates`, {}, { stage: 'verify_token' });
    return { access: 'allowed', reason: 'writable' };
  } catch (error) {
    const status = error instanceof DeployError ? error.status : undefined;
    if (status === 400 || status === 422) return { access: 'allowed', reason: 'writable' };
    if (status === 401 || status === 403) return { access: 'denied', reason: 'readonly' };
    return { access: 'unknown', reason: 'probe_failed' };
  }
}

export const CERTIFICATE_PERMISSION_HINT = {
  missing: '没有确认到 Token 的账户级「SSL 和证书」权限。'
    + '需要上传微信 mTLS 证书时，请确认 Token 包含「账户 · SSL 和证书 · 编辑」。',
  readonly: 'Token 看起来只有「SSL 和证书」的读权限。'
    + '上传证书需要「账户 · SSL 和证书 · 编辑」。',
};
