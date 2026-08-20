import { DeployError } from './errors.js';
import { splitStatements } from './sql-splitter.js';

export async function createDatabase(client, accountId, name) {
  try {
    const existing = await client.getJSON(
      `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=10`,
      { stage: 'd1_create' },
    );
    const match = (Array.isArray(existing.result) ? existing.result : [])
      .find((database) => database?.name === name);
    const existingId = match?.uuid ?? match?.id;
    if (existingId) return { databaseId: existingId, reused: true };

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
    return { databaseId, reused: false };
  } catch (err) {
    if (err instanceof DeployError && err.stage === 'cf_request') {
      throw new DeployError(
        'd1_create',
        `创建或查询 D1 数据库失败：${err.message}`,
        { retryable: err.retryable, detail: err.detail },
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
