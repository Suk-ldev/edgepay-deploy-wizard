import { DeployError } from './errors.js';
import { splitStatements } from './sql-splitter.js';

const EDGE_PAY_DATA_TABLES = Object.freeze([
  'runtime_settings',
  'payment_attempts',
  'receipt_events',
  'notification_tasks',
  'order_controls',
  'order_operation_logs',
  'refund_orders',
  'admin_login_limits',
]);

function d1Rows(response) {
  const result = Array.isArray(response?.result) ? response.result[0] : response?.result;
  return Array.isArray(result?.results) ? result.results : [];
}

async function queryRows(client, accountId, databaseId, sql) {
  const response = await client.postJSON(
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { sql },
    { stage: 'd1_create' },
  );
  return d1Rows(response);
}

async function inspectDatabaseReuse(client, accountId, databaseId) {
  const quoted = EDGE_PAY_DATA_TABLES.map((table) => `'${table}'`).join(',');
  const tableRows = await queryRows(
    client,
    accountId,
    databaseId,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${quoted})`,
  );
  const existingTables = tableRows
    .map((row) => String(row?.name ?? ''))
    .filter((table) => EDGE_PAY_DATA_TABLES.includes(table));
  if (!existingTables.length) return { used: false, tables: [] };

  const countSql = existingTables
    .map((table) => `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`)
    .join(' UNION ALL ');
  const countRows = await queryRows(client, accountId, databaseId, countSql);
  const usedTables = countRows
    .filter((row) => Number(row?.row_count ?? 0) > 0)
    .map((row) => String(row.table_name))
    .filter((table) => EDGE_PAY_DATA_TABLES.includes(table));
  return { used: usedTables.length > 0, tables: usedTables };
}

export async function createDatabase(client, accountId, name) {
  try {
    const existing = await client.getJSON(
      `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=10`,
      { stage: 'd1_create' },
    );
    const match = (Array.isArray(existing.result) ? existing.result : [])
      .find((database) => database?.name === name);
    const existingId = match?.uuid ?? match?.id;
    if (existingId) {
      const reuse = await inspectDatabaseReuse(client, accountId, existingId);
      if (reuse.used) {
        throw new DeployError(
          'd1_create',
          `发现同名 D1 数据库 ${name} 里已有 EdgePay 数据，不能用新密钥覆盖部署。请换一个项目名，或在 Cloudflare 手动确认并删除这个残留 D1 后重试。`,
          {
            retryable: false,
            action: 'rename_project',
            detail: `used_tables=${reuse.tables.join(',')}`,
          },
        );
      }
      return { databaseId: existingId, reused: true };
    }

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
    if (err instanceof DeployError && err.stage === 'd1_create') throw err;
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

export async function applySchema(client, accountId, databaseId, schemaText, { upgrade = false } = {}) {
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
        upgrade
          ? `升级数据库结构时第 ${i + 1}/${statements.length} 条语句失败，Worker 程序尚未更新：${err.message}`
          : `建表在第 ${i + 1}/${statements.length} 条语句失败，数据库处于不完整状态，请删除后重试：${err.message}`,
        { retryable: false, detail: err instanceof DeployError ? err.detail : String(err) },
      );
    }
  }
  return statements.length;
}
