/**
 * EdgeOne Makers 部署流程：校验 Token、检查同名项目、部署 / 无损升级。
 *
 * 和 Cloudflare 流程的差别：
 * - 数据库是商户自备的 PostgreSQL，部署站连不到它，建表由支付站第一次连库时自己完成；
 * - 部署包在这里组装成 zip 传到 Makers 的 COS 临时位置，再由 Makers 构建；
 * - Makers 没有分钟级定时任务，完成页给出 /internal/tick 地址和定时器教程；
 * - 自定义域名只能在 Makers 控制台绑定（没有公开 API），完成页给出操作指引。
 */

import { readConfig } from './config.js';
import { DEPLOY_JSON_MAX_BYTES, readBoundedJson } from './body-limits.js';
import { DeployError, redact } from './lib/errors.js';
import { licenseFetcher, normalizePublicBaseUrl, verifyLicense } from './lib/license-verifier.js';
import { MakersClient } from './lib/makers-client.js';
import { makersPackageFiles, MAKERS_PACKAGE_ROOT } from './lib/makers-artifact.js';
import { chunkedEnv, hexSecret, isChunkOf, pemForEnv } from './lib/makers-env.js';
import { fetchCommercialRelease } from './lib/template-fetcher.js';
import { createProgressStream, MAKERS_STEP_LABELS } from './lib/progress-stream.js';
import { validateWechatMtlsInput } from './lib/cf-mtls.js';
import { createZip } from './lib/zip-store.js';

const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/u;
const SITES = new Set(['china', 'global']);
const AREAS = new Set(['global', 'overseas']);
const DEPLOY_TIMEOUT_MS = 8 * 60_000;
const DEPLOY_POLL_MS = 5_000;
/** EdgePay 部署一定有的变量；同名项目缺了它们就不是 EdgePay，不能当升级对象。 */
const EDGEPAY_ENV_MARKERS = ['DATABASE_URL', 'ADMIN_TOKEN', 'CONFIG_ENCRYPTION_KEY'];

function jsonError(message, status = 400, extra = {}) {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

async function readBody(request, maxBytes) {
  try {
    return { body: await readBoundedJson(request, maxBytes) };
  } catch (error) {
    return { error: jsonError(String(error.message ?? '请求体不是合法 JSON'), Number(error.status) || 400) };
  }
}

function tokenAndSite(body) {
  const token = String(body?.makersToken ?? '').trim();
  const site = String(body?.site ?? '');
  if (!token) return { error: '需要填写 Makers API Token' };
  if (!SITES.has(site)) return { error: '请选择 Makers 账号所在站点（中国站或国际站）' };
  return { token, site };
}

export function validateDatabaseUrl(value) {
  const text = String(value ?? '').trim();
  let url;
  try { url = new URL(text); } catch { throw new Error('数据库连接串格式不对，应为 postgres://用户:密码@主机:端口/库名'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.replace(/^\/+/u, '')) {
    throw new Error('数据库连接串格式不对，应为 postgres://用户:密码@主机:端口/库名');
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('数据库主机不能是本机地址：Makers 云函数要能从公网连到它');
  }
  if (text.length > 900) throw new Error('数据库连接串太长（Makers 单个环境变量最多 1000 字节）');
  return text;
}

/** 同名项目是不是 EdgePay：必须是直接上传类型，并且带着 EdgePay 的核心变量。 */
export function inspectMakersProject(project) {
  if (!project) return { exists: false, compatible: false };
  const keys = new Set((project.EnvVars ?? []).map((item) => item.Key));
  return {
    exists: true,
    compatible: project.Provider === 'Upload' && EDGEPAY_ENV_MARKERS.every((key) => keys.has(key)),
    projectId: project.ProjectId,
    area: project.Area,
    presetDomain: project.PresetDomain ?? '',
    customDomains: (project.CustomDomains ?? []).map((item) => String(item?.Domain ?? item?.Name ?? item ?? '')).filter(Boolean),
    wechatMtlsConfigured: keys.has('WECHAT_MTLS_CERT') && keys.has('WECHAT_MTLS_KEY'),
  };
}

function siteHint(error, site) {
  const other = site === 'china' ? '国际站' : '中国站';
  return /auth|token|unauthor|认证|鉴权/iu.test(String(error?.message ?? ''))
    ? `Token 校验失败；如果这个 Token 是在${other}创建的，请切换站点后重试`
    : String(error?.message ?? 'Token 校验失败');
}

export async function handleMakersVerifyToken(request) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const credentials = tokenAndSite(body);
  if (credentials.error) return jsonError(credentials.error);
  try {
    const client = new MakersClient(credentials.token, credentials.site);
    await client.call('DescribePagesProjects', { Offset: 0, Limit: 1 }, { stage: 'verify_token' });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: siteHint(err, credentials.site) });
  }
}

export async function handleMakersCheckProject(request) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const credentials = tokenAndSite(body);
  if (credentials.error) return jsonError(credentials.error);
  if (!PROJECT_NAME_RE.test(String(body?.projectName ?? ''))) return jsonError('项目名格式不对');
  try {
    const client = new MakersClient(credentials.token, credentials.site);
    const state = inspectMakersProject(await client.findProject(body.projectName, { stage: 'project_check' }));
    return Response.json({
      ok: true,
      exists: state.exists,
      compatible: state.compatible,
      area: state.area ?? '',
      wechatMtlsConfigured: state.wechatMtlsConfigured === true,
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof DeployError ? err.message : '检查同名项目失败' });
  }
}

export function validateMakersInput(body) {
  const errors = {};
  const mode = body?.mode === 'upgrade' ? 'upgrade' : 'install';
  const credentials = tokenAndSite(body);
  if (credentials.error) errors.makersToken = credentials.error;
  if (!PROJECT_NAME_RE.test(String(body?.projectName ?? ''))) {
    errors.projectName = '项目名只能包含小写字母、数字和短横线，且不能以短横线开头或结尾，最长 58 个字符';
  }
  if (body?.mode !== undefined && !['install', 'upgrade'].includes(body.mode)) errors.mode = '部署方式只能是 install 或 upgrade';
  if (mode === 'install' && !AREAS.has(String(body?.area ?? ''))) errors.area = '请选择加速区域';
  if (mode === 'install' || body?.databaseUrl) {
    try { validateDatabaseUrl(body?.databaseUrl); } catch (error) { errors.databaseUrl = error.message; }
  }
  if (body?.adminUsername !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/u.test(body.adminUsername)) {
    errors.adminUsername = '管理员用户名格式不对';
  }
  if (mode === 'install') {
    if (typeof body?.adminPassword !== 'string' || body.adminPassword.length < 8 || body.adminPassword.length > 128) {
      errors.adminPassword = '管理员密码必须填写，长度为 8 至 128 个字符';
    }
    if (body?.watcherTransportSecret && !/^[^\s]{24,128}$/u.test(body.watcherTransportSecret)) {
      errors.watcherTransportSecret = 'Watcher 通信密钥应为 24 至 128 个不含空白的字符，留空时自动生成';
    }
  }
  try {
    validateWechatMtlsInput(body?.wechatMtlsCertificate, body?.wechatMtlsPrivateKey);
  } catch (error) {
    errors.wechatMtls = error.message;
  }
  if (!/^EPL1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(String(body?.edgepayLicense ?? ''))) {
    errors.edgepayLicense = '需要填写从 License 站生成的永久 License（EPL1.payload.signature）';
  }
  try { normalizePublicBaseUrl(body?.publicBaseUrl); } catch (error) { errors.publicBaseUrl = error.message; }
  return errors;
}

/** 等 Makers 构建完成；失败时把构建日志末尾带回来，别只给一句 Failed。 */
async function waitForDeployment(client, projectId, deploymentId, { sleep, now }) {
  const deadline = now() + DEPLOY_TIMEOUT_MS;
  for (;;) {
    const deployment = await client.deploymentStatus(projectId, deploymentId, { stage: 'deploy' });
    const status = String(deployment?.Status ?? '');
    if (status === 'Success') return deployment;
    if (['Failed', 'Invalid', 'Canceled', 'Cancelled'].includes(status)) {
      const log = await client.deploymentLogTail(projectId, deploymentId);
      throw new DeployError('deploy', `Makers 构建失败（${status}）`, { retryable: true, detail: log || undefined });
    }
    if (now() > deadline) {
      throw new DeployError('deploy', 'Makers 构建超过 8 分钟仍未完成，请到控制台查看部署状态', { retryable: true });
    }
    await sleep(DEPLOY_POLL_MS);
  }
}

/**
 * 部署后访问一次 /health：会连库并完成首次建表，数据库连不上在这里就能看出来。
 * 访问默认域名时带上预览凭证 Cookie（中国大陆访问默认域名必须有它）。
 */
async function checkHealth(url, fetchImpl, cookie = '') {
  try {
    const response = await fetchImpl(`${url}/health`, {
      headers: { 'user-agent': 'edgepay-deploy-wizard', ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
    });
    if (response.ok) return '';
    // 平台自己的错误页是整页 HTML，只有支付站的 JSON 错误值得原样带回。
    const text = String(response.headers.get('content-type') ?? '').includes('json') ? (await response.text()).slice(0, 200) : '';
    if (response.status === 500 || response.status === 503) {
      return `支付站返回 ${response.status}，多半是连不上数据库：确认连接串正确、数据库允许公网访问、账号有建表权限${text ? `（${text}）` : ''}`;
    }
    if ([301, 302, 401, 403].includes(response.status)) {
      return `默认域名拒绝了检查请求（${response.status}），稍后请用完成页的后台预览链接打开支付站确认`;
    }
    return `支付站返回 ${response.status}${text ? `：${text}` : ''}`;
  } catch (error) {
    return `从部署站访问支付站失败（${String(error?.message ?? error)}），稍后可以手动打开 /health 检查`;
  }
}

export async function handleMakersDeploy(request, env, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = () => Date.now(),
  verifyLicenseImpl = (license) => verifyLicense(license, licenseFetcher(env)),
} = {}) {
  const { body, error } = await readBody(request, DEPLOY_JSON_MAX_BYTES);
  if (error) return error;
  const validationErrors = validateMakersInput(body);
  if (Object.keys(validationErrors).length) {
    return Response.json({ error: '输入校验失败', fields: validationErrors }, { status: 400 });
  }
  const config = readConfig(env);
  if (!config.templateSha) return Response.json({ error: '向导没有配置 TEMPLATE_COMMIT_SHA，联系管理员' }, { status: 500 });

  const mode = body.mode === 'upgrade' ? 'upgrade' : 'install';
  const projectName = String(body.projectName);
  const adminUsername = body.adminUsername || 'admin';
  const databaseUrl = body.databaseUrl ? validateDatabaseUrl(body.databaseUrl) : '';
  const mtlsCertificate = String(body.wechatMtlsCertificate ?? '');
  const mtlsPrivateKey = String(body.wechatMtlsPrivateKey ?? '');
  const secrets = [
    body.makersToken, body.edgepayLicense, body.adminPassword, body.watcherTransportSecret,
    databaseUrl, mtlsCertificate, mtlsPrivateKey,
  ].filter(Boolean).map(String);
  const client = new MakersClient(String(body.makersToken).trim(), body.site, { fetchImpl, sensitiveValues: secrets });
  const { readable, emit, close } = createProgressStream();
  const step = (stage) => ({ stage, label: MAKERS_STEP_LABELS[stage] });

  (async () => {
    try {
      let publicBaseUrl = normalizePublicBaseUrl(body.publicBaseUrl);
      await emit({ ...step('validate'), status: 'done' });

      await emit({ ...step('verify_token'), status: 'started' });
      try {
        await client.call('DescribePagesProjects', { Offset: 0, Limit: 1 }, { stage: 'verify_token' });
      } catch (err) {
        throw new DeployError('verify_token', siteHint(err, body.site), { retryable: false });
      }
      await emit({ ...step('verify_token'), status: 'done', detail: body.site === 'china' ? '中国站' : '国际站' });

      await emit({ ...step('license_verify'), status: 'started' });
      const licenseInfo = await verifyLicenseImpl(body.edgepayLicense);
      if (!publicBaseUrl) publicBaseUrl = `https://${licenseInfo.domain}`;
      if (new URL(publicBaseUrl).hostname !== licenseInfo.domain) {
        throw new DeployError('license_verify', `公开访问地址与 License 域名不一致；License 绑定 ${licenseInfo.domain}`, { retryable: false });
      }
      await emit({ ...step('license_verify'), status: 'done', detail: `${licenseInfo.domain} · ${licenseInfo.entitlements.length} 个插件` });

      await emit({ ...step('project_check'), status: 'started' });
      let project = await client.findProject(projectName, { stage: 'project_check' });
      let state = inspectMakersProject(project);
      if (mode === 'upgrade') {
        if (!state.exists) throw new DeployError('project_check', '没有找到同名 Makers 项目，请返回并选择新建部署', { retryable: false });
        if (!state.compatible) throw new DeployError('project_check', '同名 Makers 项目不是可识别的 EdgePay，已停止升级', { retryable: false });
        await emit({ ...step('project_check'), status: 'done', detail: '已确认原 EdgePay，保留现有配置和数据' });
      } else if (state.exists) {
        throw new DeployError('project_check', '同名 Makers 项目已存在，请确认升级或更换项目名', {
          retryable: false,
          action: state.compatible ? 'confirm_upgrade' : 'rename_project',
        });
      } else {
        await emit({ ...step('project_check'), status: 'done', detail: '项目名可用' });
      }

      await emit({ ...step('template_fetch'), status: 'started' });
      const release = await fetchCommercialRelease({
        owner: config.templateOwner,
        repo: config.templateRepo,
        sha: config.templateSha,
        subdir: config.templateSubdir,
        githubToken: config.githubToken,
        manifestSha256: config.templateManifestSha256,
        entitlements: licenseInfo.entitlements,
        platform: 'makers',
        fetchImpl,
      });
      const installedNames = release.installed.map((plugin) => plugin.name || plugin.code);
      await emit({
        ...step('template_fetch'),
        status: 'done',
        detail: `${release.manifest.release ?? ''} · ${installedNames.length ? `已装载付费插件：${installedNames.join('、')}` : '未装载付费插件'}`,
      });
      if (release.unavailable.length) {
        await emit({
          ...step('template_fetch'),
          status: 'warning',
          detail: `以下已购插件在当前发行版本中尚未提供，本次未安装：${release.unavailable.join('、')}`,
        });
      }

      await emit({ ...step('package'), status: 'started' });
      const files = makersPackageFiles({
        sourceFiles: release.sourceFiles,
        entry: release.manifest.entry ?? 'index.js',
        runtimeSource: release.makersRuntime,
      });
      const zip = createZip(files.map((file) => ({ path: `${MAKERS_PACKAGE_ROOT}/${file.path}`, content: file.content })));
      await emit({ ...step('package'), status: 'done', detail: `${files.length} 个文件 · ${(zip.length / 1024 / 1024).toFixed(2)} MB` });

      let projectId = state.projectId;
      if (mode === 'install') {
        await emit({ ...step('project_create'), status: 'started' });
        projectId = await client.createProject(projectName, body.area, { stage: 'project_create' });
        await emit({ ...step('project_create'), status: 'done', detail: body.area === 'overseas' ? '加速区域：中国大陆以外' : '加速区域：全球（含中国大陆）' });
      } else {
        await emit({ ...step('project_create'), status: 'done', detail: '沿用原项目' });
      }

      await emit({ ...step('env_config'), status: 'started' });
      const generated = mode === 'install' ? {
        ADMIN_TOKEN: String(body.adminPassword),
        // 十六进制：base64url 随机串偶尔会被 Makers 当成"危险字符串"拒收。
        EPAY_KEY: hexSecret(),
        POLL_TRIGGER_TOKEN: hexSecret(),
        CONFIG_ENCRYPTION_KEY: hexSecret(),
        WATCHER_TRANSPORT_SECRET: body.watcherTransportSecret || hexSecret(),
      } : {};
      secrets.push(...Object.values(generated));
      const chunked = {
        EDGEPAY_LICENSE: String(body.edgepayLicense),
        ...(mtlsCertificate && mtlsPrivateKey ? {
          WECHAT_MTLS_CERT: pemForEnv(mtlsCertificate),
          WECHAT_MTLS_KEY: pemForEnv(mtlsPrivateKey),
        } : {}),
      };
      const vars = {
        ...(mode === 'install' ? {
          PUBLIC_BASE_URL: publicBaseUrl,
          EPAY_PID: '1000',
          ADMIN_USERNAME: adminUsername,
        } : {}),
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        EDGEPAY_PROJECT_NAME: projectName,
        ...generated,
        ...Object.assign({}, ...Object.entries(chunked).map(([key, value]) => chunkedEnv(key, value))),
      };
      try {
        await client.setEnvVars(projectId, vars, { stage: 'env_config' });
        // 拆分变量变短时，把多出来的旧分段删掉，否则平台层会把它们拼到新值后面。
        const stale = (await client.listEnvVars(projectId, { stage: 'env_config' }))
          .filter((item) => Object.keys(chunked).some((name) => isChunkOf(name, item.Key)) && !(item.Key in vars));
        await client.deleteEnvVars(projectId, stale, { stage: 'env_config' });
      } catch (err) {
        if (/unsecurity/iu.test(String(err?.message ?? ''))) {
          throw new DeployError('env_config', 'Makers 拒收了其中一个值（含它认为危险的字符组合）；多半是管理员密码或自定义的 Watcher 通信密钥，请换一个再试', {
            retryable: false,
          });
        }
        throw err;
      }
      await emit({
        ...step('env_config'),
        status: 'done',
        detail: mode === 'install' ? `${Object.keys(vars).length} 个环境变量` : '保留原密钥与配置，只更新 License 等部署信息',
        // 密钥此刻已经写进项目。后面上传或构建失败时，重试会走"无损升级"而不再重新生成，
        // 所以现在就交给页面：失败了也能先保存下来。
        ...(mode === 'install' ? { secrets: generated } : {}),
      });

      await emit({ ...step('upload'), status: 'started' });
      const tempBucketPath = await client.uploadPackage(projectId, zip, `${MAKERS_PACKAGE_ROOT}.zip`, { stage: 'upload' });
      await emit({ ...step('upload'), status: 'done' });

      await emit({ ...step('deploy'), status: 'started', detail: 'Makers 正在构建，通常需要 1～2 分钟' });
      const deploymentId = await client.createDeployment(projectId, tempBucketPath, { stage: 'deploy' });
      await waitForDeployment(client, projectId, deploymentId, { sleep, now });
      await emit({ ...step('deploy'), status: 'done', detail: deploymentId });

      project = await client.findProject(projectName, { stage: 'health_check' });
      state = inspectMakersProject(project);
      const presetUrl = state.presetDomain ? `https://${state.presetDomain}` : '';
      const domain = new URL(publicBaseUrl).hostname;
      const domainBound = state.customDomains.includes(domain);
      await emit({ ...step('health_check'), status: 'started' });
      // 自定义域名还没绑时只能走默认域名，而中国大陆访问默认域名需要预览凭证。
      const preview = state.presetDomain
        ? await client.previewToken(state.presetDomain, { stage: 'health_check' }).catch(() => null)
        : null;
      const previewCookie = preview ? `eo_token=${preview.token}; eo_time=${preview.timestamp}` : '';
      const healthWarning = domainBound || presetUrl
        ? await checkHealth(domainBound ? publicBaseUrl : presetUrl, fetchImpl, domainBound ? '' : previewCookie)
        : '没有拿到 Makers 默认域名，稍后请手动打开 /health 检查';
      await emit(healthWarning
        ? { ...step('health_check'), status: 'warning', message: healthWarning }
        : { ...step('health_check'), status: 'done', detail: '支付站已连上数据库并完成建表' });

      const pollToken = generated.POLL_TRIGGER_TOKEN ?? '';
      await emit({
        stage: 'complete',
        status: 'done',
        result: {
          platform: 'makers',
          mode,
          accessUrl: publicBaseUrl,
          adminUrl: `${publicBaseUrl}/admin`,
          adminUsername,
          presetUrl,
          // 绑定自定义域名之前用它进后台（3 小时有效，中国大陆访问默认域名必须带凭证）。
          previewAdminUrl: preview ? `${presetUrl}/admin?eo_token=${preview.token}&eo_time=${preview.timestamp}` : '',
          consoleUrl: `${client.consoleUrl}/project/${projectId}`,
          domain,
          domainBound,
          healthWarning,
          tickUrl: pollToken ? `${publicBaseUrl}/internal/tick?token=${pollToken}` : '',
          ...generated,
        },
      });
    } catch (err) {
      const deployError = err instanceof DeployError ? err : new DeployError('unknown', redact(String(err), secrets));
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

  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}
