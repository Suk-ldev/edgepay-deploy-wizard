import { DeployError } from './errors.js';
import { splitStatements } from './sql-splitter.js';

export async function createDatabase(client, accountId, name) {
  try {
    const json = await client.postJSON(`/accounts/${accountId}/d1/database`, { name }, { stage: 'd1_create' });
    // Cloudflare 的响应字段名在不同文档来源里写法不一致（uuid vs id），两个都尝试一下，
    // 拿不到就明确报错而不是悄悄往下传一个 undefined。
    const databaseId = json.result?.uuid ?? json.result?.id;
    if (!databaseId) {
      throw new DeployError('d1_create', 'D1 创建成功但拿不到返回的 database_id（响应字段名和预期不一致）', {
        retryable: false,
        detail: JSON.stringify(json.result ?? {}),
      });
    }
    return databaseId;
  } catch (err) {
    if (err instanceof DeployError && err.stage === 'cf_request') {
      throw new DeployError(
        'd1_create',
        `创建 D1 数据库失败：${err.message}。可能已经建过一个同名库 "${name}"，去 Cloudflare 控制台的 D1 页面确认或删除后再重试。`,
        { retryable: false, detail: err.detail },
      );
    }
    throw err;
  }
}

export async function applySchema(client, accountId, databaseId, schemaText) {
  const statements = splitStatements(schemaText);
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i];
    try {
      await client.postJSON(
        `/accounts/${accountId}/d1/database/${databaseId}/query`,
        { sql },
        { stage: 'd1_schema' },
      );
    } catch (err) {
      throw new DeployError(
        'd1_schema',
        `建表在第 ${i + 1}/${statements.length} 条语句失败，数据库处于不完整状态，请删除后重试：${err.message}`,
        { retryable: false, detail: err instanceof DeployError ? err.detail : String(err) },
      );
    }
  }
  return statements.length;
}
