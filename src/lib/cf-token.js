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
