import { DeployError } from './errors.js';

// 未在真实账号上验证过，仅根据 Cloudflare 文档推断：
//   - D1 binding 的 type 到底是 "d1" 还是 "d1_database"。
//   - 除 main_module 外的其余模块 part，命名是否必须和 import 里的相对路径字符串（去掉开头的 "./"）
//     完全一致。这里假设是这样——如果实测不对，整个"17 个文件原样上传不用打包"的前提就要重新设计。
// 详见项目计划文档"未知风险"一节。
const D1_BINDING_TYPE = 'd1';

export function buildScriptMetadata({ databaseId, secrets, vars, mainModule = 'index.js' }) {
  const bindings = [
    { type: D1_BINDING_TYPE, name: 'DB', id: databaseId },
    ...Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    ...Object.entries(secrets).map(([name, text]) => ({ type: 'secret_text', name, text })),
  ];

  return {
    main_module: mainModule,
    compatibility_date: new Date().toISOString().slice(0, 10),
    bindings,
    triggers: { crons: ['* * * * *'] },
  };
}

/**
 * sourceFiles: [{ path: 'index.js', content: string }, ...] —— path 是相对 src/ 根目录的文件名，
 * 不带 "./" 前缀，和 import 语句里去掉 "./" 之后的字符串一致。
 */
export async function uploadWorkerScript(client, accountId, scriptName, {
  sourceFiles,
  databaseId,
  secrets,
  vars,
}) {
  const metadata = buildScriptMetadata({ databaseId, secrets, vars });

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const file of sourceFiles) {
    form.append(
      file.path,
      new Blob([file.content], { type: 'application/javascript+module' }),
      file.path,
    );
  }

  try {
    const json = await client.putMultipart(`/accounts/${accountId}/workers/scripts/${scriptName}`, form, {
      stage: 'script_upload',
    });
    return json.result;
  } catch (err) {
    throw new DeployError(
      'script_upload',
      `D1 已经就绪，但 Worker 脚本上传失败：${err.message}。请删除刚创建的 D1 数据库后重试整个向导。`,
      { retryable: false, detail: err instanceof DeployError ? err.detail : String(err) },
    );
  }
}

export async function uploadWorkerContent(client, accountId, scriptName, { sourceFiles }) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'index.js' })], { type: 'application/json' }), 'metadata.json');
  for (const file of sourceFiles) {
    form.append(
      file.path,
      new Blob([file.content], { type: 'application/javascript+module' }),
      file.path,
    );
  }
  try {
    const json = await client.putMultipart(
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/content`,
      form,
      { stage: 'script_upload' },
    );
    return json.result;
  } catch (error) {
    throw new DeployError('script_upload', `Worker 程序升级失败：${error.message}`, {
      retryable: error instanceof DeployError ? error.retryable : false,
      detail: error instanceof DeployError ? error.detail : String(error),
    });
  }
}
