import { readConfig } from './config.js';
import { CloudflareClient } from './lib/cf-client.js';
import { verifyToken } from './lib/cf-token.js';
import { createDatabase, applySchema } from './lib/cf-d1.js';
import { uploadWorkerScript } from './lib/cf-worker-script.js';
import { enableWorkersDevSubdomain } from './lib/cf-subdomain.js';
import { generateDeploySecrets } from './lib/secret-generator.js';
import { fetchTemplateFiles } from './lib/template-fetcher.js';
import { createProgressStream, STEP_LABELS } from './lib/progress-stream.js';
import { DeployError, redact } from './lib/errors.js';
import { licenseFetcher, normalizePublicBaseUrl, verifyLicense } from './lib/license-verifier.js';

const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

export function validateInput(body) {
  const errors = {};
  if (!body?.cfApiToken || typeof body.cfApiToken !== 'string') errors.cfApiToken = '需要填写 Cloudflare API Token';
  if (!body?.cfAccountId || !ACCOUNT_ID_RE.test(body.cfAccountId)) errors.cfAccountId = 'Account ID 应该是 32 位十六进制字符串';
  if (!body?.projectName || !PROJECT_NAME_RE.test(body.projectName)) {
    errors.projectName = '项目名只能包含小写字母、数字和短横线，且不能以短横线开头或结尾，最长 58 个字符';
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

      await emit({ ...step('template_fetch'), status: 'started' });
      const files = await fetchTemplateFiles({
        owner: config.templateOwner,
        repo: config.templateRepo,
        sha: config.templateSha,
        subdir: config.templateSubdir,
        githubToken: config.githubToken,
      });
      const srcFiles = files
        .filter((f) => f.path.startsWith('src/'))
        .map((f) => ({ path: f.path.slice('src/'.length), content: new TextDecoder().decode(f.bytes) }));
      const schemaFile = files.find((f) => f.path === 'schema.sql');
      if (!schemaFile) throw new DeployError('template_fetch', '模板里没有找到 schema.sql', { retryable: false });
      const schemaText = new TextDecoder().decode(schemaFile.bytes);
      await emit({ ...step('template_fetch'), status: 'done', detail: `${files.length} 个文件` });

      await emit({ ...step('d1_create'), status: 'started' });
      const database = await createDatabase(client, cfAccountId, projectName);
      const databaseId = database.databaseId;
      await emit({ ...step('d1_create'), status: 'done', detail: database.reused ? `${databaseId}（复用现有数据库）` : databaseId });

      await emit({ ...step('d1_schema'), status: 'started' });
      const statementCount = await applySchema(client, cfAccountId, databaseId, schemaText);
      await emit({ ...step('d1_schema'), status: 'done', detail: `${statementCount} 条语句` });

      await emit({ ...step('generate_secrets'), status: 'started' });
      const deploySecrets = generateDeploySecrets();
      deploySecrets.EDGEPAY_LICENSE = String(body.edgepayLicense);
      secrets.push(...Object.values(deploySecrets));
      await emit({ ...step('generate_secrets'), status: 'done' });

      await emit({ ...step('script_upload'), status: 'started' });
      const placeholderBaseUrl = publicBaseUrl || `https://${projectName}.workers.dev`;
      await uploadWorkerScript(client, cfAccountId, projectName, {
        sourceFiles: srcFiles,
        databaseId,
        secrets: deploySecrets,
        vars: {
          PUBLIC_BASE_URL: placeholderBaseUrl,
          EPAY_PID: '1000',
          ADMIN_USERNAME: adminUsername,
        },
      });
      await emit({ ...step('script_upload'), status: 'done' });

      await emit({ ...step('enable_subdomain'), status: 'started' });
      const workersDevUrl = await enableWorkersDevSubdomain(client, cfAccountId, projectName);
      await emit({ ...step('enable_subdomain'), status: 'done', detail: workersDevUrl });

      await emit({
        stage: 'complete',
        status: 'done',
        result: {
          workersDevUrl,
          adminUrl: `${workersDevUrl}/admin`,
          adminUsername,
          ...deploySecrets,
          note: '如果之后绑定了自定义域名，记得回后台把 PUBLIC_BASE_URL 改成正式域名并重新部署一次。',
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
      });
    } finally {
      await close();
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}
