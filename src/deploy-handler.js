import { readConfig } from './config.js';
import { CloudflareClient } from './lib/cf-client.js';
import { verifyToken } from './lib/cf-token.js';
import { createDatabase, applySchema } from './lib/cf-d1.js';
import { uploadWorkerContent, uploadWorkerScript } from './lib/cf-worker-script.js';
import { ensureWorkerCustomDomain } from './lib/cf-domain.js';
import { generateDeploySecrets } from './lib/secret-generator.js';
import { fetchTemplateFiles } from './lib/template-fetcher.js';
import { createProgressStream, STEP_LABELS } from './lib/progress-stream.js';
import { DeployError, redact } from './lib/errors.js';
import { licenseFetcher, normalizePublicBaseUrl, verifyLicense } from './lib/license-verifier.js';
import { inspectWorker } from './lib/cf-worker-state.js';

const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

export function validateInput(body) {
  const errors = {};
  if (!body?.cfApiToken || typeof body.cfApiToken !== 'string') errors.cfApiToken = '需要填写 Cloudflare API Token';
  if (!body?.cfAccountId || !ACCOUNT_ID_RE.test(body.cfAccountId)) errors.cfAccountId = 'Account ID 应该是 32 位十六进制字符串';
  if (!body?.projectName || !PROJECT_NAME_RE.test(body.projectName)) {
    errors.projectName = '项目名只能包含小写字母、数字和短横线，且不能以短横线开头或结尾，最长 58 个字符';
  }
  if (body?.mode !== undefined && !['install', 'upgrade'].includes(body.mode)) {
    errors.mode = '部署方式只能是 install 或 upgrade';
  }
  if (body?.adminUsername !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(body.adminUsername)) {
    errors.adminUsername = '管理员用户名格式不对';
  }
  if (!body?.edgepayLicense) {
    errors.edgepayLicense = '需要填写从 License 站生成的永久 License';
  } else if (!/^EPL1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(body.edgepayLicense)) {
    errors.edgepayLicense = 'License 格式应为 EPL1.payload.signature';
  }
  try { normalizePublicBaseUrl(body?.publicBaseUrl); } catch (error) { errors.publicBaseUrl = error.message; }
  return errors;
}

export async function handleDeploy(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: '请求体不是合法 JSON' }), { status: 400 });
  }

  const validationErrors = validateInput(body);
  if (Object.keys(validationErrors).length > 0) {
    return new Response(JSON.stringify({ error: '输入校验失败', fields: validationErrors }), { status: 400 });
  }

  const { cfApiToken, cfAccountId, projectName } = body;
  const mode = body.mode === 'upgrade' ? 'upgrade' : 'install';
  const adminUsername = body.adminUsername || 'admin';
  let publicBaseUrl = normalizePublicBaseUrl(body.publicBaseUrl);
  const config = readConfig(env);

  if (!config.templateSha) {
    return new Response(JSON.stringify({ error: '向导没有配置 TEMPLATE_COMMIT_SHA，联系管理员' }), { status: 500 });
  }

  const { readable, emit, close } = createProgressStream();

  // 编排逻辑异步跑，边跑边往流里写进度；HTTP 响应立刻返回这个流。
  (async () => {
    const client = new CloudflareClient(cfApiToken);
    const secrets = [cfApiToken, body.edgepayLicense].filter(Boolean);
    const step = (stage) => ({ stage, label: STEP_LABELS[stage] });

    try {
      await emit({ ...step('validate'), status: 'done' });

      await emit({ ...step('verify_token'), status: 'started' });
      await verifyToken(client, cfAccountId);
      await emit({ ...step('verify_token'), status: 'done' });

      await emit({ ...step('license_verify'), status: 'started' });
      const licenseInfo = await verifyLicense(body.edgepayLicense, licenseFetcher(env));
      if (!publicBaseUrl) publicBaseUrl = `https://${licenseInfo.domain}`;
      if (new URL(publicBaseUrl).hostname !== licenseInfo.domain) {
        throw new DeployError('license_verify', `公开访问地址与 License 域名不一致；License 绑定 ${licenseInfo.domain}`, { retryable: false });
      }
      await emit({ ...step('license_verify'), status: 'done', detail: `${licenseInfo.domain} · ${licenseInfo.entitlements.length} 个插件` });

      await emit({ ...step('project_check'), status: 'started' });
      const existingWorker = await inspectWorker(client, cfAccountId, projectName);
      if (mode === 'upgrade') {
        if (!existingWorker.exists) {
          throw new DeployError('project_check', '没有找到同名 Worker，请返回并选择新建部署', { retryable: false });
        }
        if (!existingWorker.compatible) {
          throw new DeployError('project_check', '同名 Worker 不是可识别的 EdgePay 商业版，已停止升级', { retryable: false });
        }
        await emit({ ...step('project_check'), status: 'done', detail: '已确认原 EdgePay，保留现有配置' });
      } else {
        if (existingWorker.exists) {
          throw new DeployError('project_check', '同名 Worker 已存在，请确认升级或更换项目名', {
            retryable: false,
            action: existingWorker.compatible ? 'confirm_upgrade' : 'rename_project',
          });
        }
        await emit({ ...step('project_check'), status: 'done', detail: '项目名可用' });
      }

      await emit({ ...step('template_fetch'), status: 'started' });
      const files = await fetchTemplateFiles({
        owner: config.templateOwner,
        repo: config.templateRepo,
        sha: config.templateSha,
        subdir: config.templateSubdir,
        githubToken: config.githubToken,
        expectedHashes: {
          'src/index.js': config.templateEntrySha256,
          'schema.sql': config.templateSchemaSha256,
        },
      });
      const srcFiles = files
        .filter((f) => f.path.startsWith('src/'))
        .map((f) => ({ path: f.path.slice('src/'.length), content: new TextDecoder().decode(f.bytes) }));
      const schemaFile = files.find((f) => f.path === 'schema.sql');
      if (!schemaFile) throw new DeployError('template_fetch', '模板里没有找到 schema.sql', { retryable: false });
      const schemaText = new TextDecoder().decode(schemaFile.bytes);
      await emit({ ...step('template_fetch'), status: 'done', detail: `${files.length} 个文件` });

      await emit({ ...step('d1_create'), status: 'started' });
      let databaseId;
      if (mode === 'upgrade') {
        databaseId = existingWorker.databaseId;
        await emit({ ...step('d1_create'), status: 'done', detail: '保留并复用原 D1 数据库' });
      } else {
        const database = await createDatabase(client, cfAccountId, projectName);
        databaseId = database.databaseId;
        await emit({ ...step('d1_create'), status: 'done', detail: database.reused ? `${databaseId}（复用现有数据库）` : databaseId });
      }

      await emit({ ...step('d1_schema'), status: 'started' });
      const statementCount = await applySchema(client, cfAccountId, databaseId, schemaText, { upgrade: mode === 'upgrade' });
      await emit({ ...step('d1_schema'), status: 'done', detail: `${statementCount} 条语句` });

      await emit({ ...step('generate_secrets'), status: 'started' });
      const deploySecrets = mode === 'upgrade' ? {} : generateDeploySecrets();
      if (mode === 'upgrade') {
        await emit({ ...step('generate_secrets'), status: 'done', detail: '保留现有 Secrets 和环境变量' });
      } else {
        deploySecrets.EDGEPAY_LICENSE = String(body.edgepayLicense);
        secrets.push(...Object.values(deploySecrets));
        await emit({ ...step('generate_secrets'), status: 'done' });
      }

      await emit({ ...step('script_upload'), status: 'started' });
      if (mode === 'upgrade') {
        await uploadWorkerContent(client, cfAccountId, projectName, { sourceFiles: srcFiles });
        await emit({ ...step('script_upload'), status: 'done', detail: '程序已更新，配置未改动' });
      } else {
        await uploadWorkerScript(client, cfAccountId, projectName, {
          sourceFiles: srcFiles,
          databaseId,
          secrets: deploySecrets,
          vars: {
            PUBLIC_BASE_URL: publicBaseUrl,
            EPAY_PID: '1000',
            ADMIN_USERNAME: adminUsername,
            EDGEPAY_PROJECT_NAME: projectName,
          },
        });
        await emit({ ...step('script_upload'), status: 'done' });
      }

      await emit({ ...step('bind_domain'), status: 'started' });
      let domainBindingWarning = '';
      try {
        const domain = await ensureWorkerCustomDomain(
          client,
          cfAccountId,
          projectName,
          new URL(publicBaseUrl).hostname,
        );
        await emit({
          ...step('bind_domain'),
          status: 'done',
          detail: domain.reused ? `${publicBaseUrl}（已绑定）` : `${publicBaseUrl}（绑定完成）`,
        });
      } catch (error) {
        domainBindingWarning = error instanceof DeployError ? error.message : '自定义域名绑定失败';
        await emit({
          ...step('bind_domain'),
          status: 'warning',
          message: domainBindingWarning,
          detail: error instanceof DeployError ? error.detail : String(error),
        });
      }

      await emit({
        stage: 'complete',
        status: 'done',
        result: {
          accessUrl: publicBaseUrl,
          adminUrl: `${publicBaseUrl}/admin`,
          adminUsername,
          mode,
          domainBindingWarning,
          ...deploySecrets,
          note: mode === 'upgrade'
            ? `升级完成；原 D1、插件配置、支付通道、环境变量、Secrets、定时任务和访问路由均已保留。${domainBindingWarning ? ' 自定义域名尚未绑定，修正 Cloudflare 域名状态后可再次无损升级重试。' : ''}`
            : domainBindingWarning
              ? 'Worker 和 D1 已部署，全部密钥如下；自定义域名尚未绑定，修正 Cloudflare 域名状态后可用同名 Worker 选择无损升级重试。'
              : 'License 域名已直接绑定到 Worker；workers.dev 未开启。',
        },
      });
    } catch (err) {
      const deployError = err instanceof DeployError
        ? err
        : new DeployError('unknown', redact(String(err), secrets));
      await emit({
        stage: deployError.stage,
        status: 'error',
        message: redact(deployError.message, secrets),
        retryable: deployError.retryable,
        detail: redact(deployError.detail, secrets),
        action: deployError.action,
      });
    } finally {
      await close();
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}
