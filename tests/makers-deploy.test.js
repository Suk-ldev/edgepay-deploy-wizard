import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { handleMakersDeploy, inspectMakersProject, validateDatabaseUrl, validateMakersInput } from '../src/makers-handlers.js';
import { makersPackageFiles } from '../src/lib/makers-artifact.js';
import { cosAuthorization } from '../src/lib/makers-client.js';
import { chunkedEnv, isChunkOf, MAKERS_ENV_CHUNK, pemForEnv } from '../src/lib/makers-env.js';
import { crc32, createZip } from '../src/lib/zip-store.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 按中央目录把 zip 读回来：名字、内容、CRC 和 Unix 权限都要对。 */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const data = bytes.subarray(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + size);
    assert.equal(crc32(data), crc, `${name} 的 CRC 不对`);
    files.set(name, { text: decoder.decode(data), mode });
    offset += 46 + nameLength;
  }
  return files;
}

test('zip：存储模式、UTF-8 文件名、0644 权限，内容原样读回', () => {
  const zip = createZip([
    { path: 'edgepay/package.json', content: '{"type":"module"}' },
    { path: 'edgepay/cloud-functions/[[default]].js', content: encoder.encode('export function onRequest() {}') },
    { path: 'edgepay/说明.txt', content: '中文' },
  ]);
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ['edgepay/package.json', 'edgepay/cloud-functions/[[default]].js', 'edgepay/说明.txt']);
  assert.equal(files.get('edgepay/说明.txt').text, '中文');
  assert.equal(files.get('edgepay/package.json').mode, 0o100644);
  assert.throws(() => createZip([{ path: 'a', content: '1' }, { path: 'a', content: '2' }]), /不合法/u);
  assert.throws(() => createZip([{ path: '../evil', content: '1' }]), /不合法/u);
});

test('部署包布局：核心改名 core.js，路由只转发，应用挂在 globalThis 上', () => {
  const files = makersPackageFiles({
    sourceFiles: [
      { path: 'index.js', content: 'export default {};' },
      { path: 'paid-plugins.js', content: 'export const paidPlugins = [];' },
      { path: 'plugins/stripe_api.js', content: 'export default {};' },
      { path: 'bundled-assets.js', content: 'export function fetchBundledAsset() {}' },
    ],
    runtimeSource: 'export function createMakersHandler() {}',
  });
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  assert.deepEqual([...byPath.keys()].sort(), [
    'cloud-functions/[[default]].js',
    'cloud-functions/_edgepay/app.js',
    'cloud-functions/_edgepay/bundled-assets.js',
    'cloud-functions/_edgepay/core.js',
    'cloud-functions/_edgepay/paid-plugins.js',
    'cloud-functions/_edgepay/plugins/stripe_api.js',
    'cloud-functions/_edgepay/runtime.js',
    'cloud-functions/index.js',
    'edgeone.json',
    'package.json',
  ]);
  for (const route of ['cloud-functions/index.js', 'cloud-functions/[[default]].js']) {
    assert.match(byPath.get(route), /export function onRequest\(context\) \{\n {2}return handleEdgepayRequest\(context\);\n\}/u);
  }
  assert.match(byPath.get('cloud-functions/_edgepay/app.js'), /globalThis\[shared\] \?\?= createMakersHandler\(worker\)/u);
  assert.doesNotMatch(byPath.get('cloud-functions/_edgepay/app.js'), /onRequest/u, '辅助模块导出 onRequest 会被 Makers 当成路由');
  assert.deepEqual(JSON.parse(byPath.get('edgeone.json')), { cloudFunctions: { maxDuration: 60 } });
  assert.throws(() => makersPackageFiles({ sourceFiles: [{ path: 'index.js', content: '' }], runtimeSource: '' }), /Makers 运行时/u);
});

test('环境变量：超长值按 900 字符拆段、PEM 换行写成字面量', () => {
  const license = `EPL1.${'a'.repeat(2_000)}.sig`;
  const parts = chunkedEnv('EDGEPAY_LICENSE', license);
  assert.deepEqual(Object.keys(parts), ['EDGEPAY_LICENSE', 'EDGEPAY_LICENSE_2', 'EDGEPAY_LICENSE_3']);
  assert.ok(Object.values(parts).every((value) => value.length <= MAKERS_ENV_CHUNK));
  assert.equal(Object.values(parts).join(''), license);
  assert.deepEqual(chunkedEnv('X', 'short'), { X: 'short' });
  assert.ok(isChunkOf('EDGEPAY_LICENSE', 'EDGEPAY_LICENSE_4'));
  assert.ok(!isChunkOf('EDGEPAY_LICENSE', 'EDGEPAY_LICENSE'));
  assert.equal(pemForEnv('-----BEGIN\r\nabc\n-----END'), '-----BEGIN\\nabc\\n-----END');
});

test('COS 签名：头和参数按小写排序进签名清单，同样输入得到同样签名', async () => {
  const input = {
    secretId: 'AKIDtest', secretKey: 'secret', method: 'PUT', pathname: '/1/edgepay/edgepay.zip',
    headers: { 'Content-Length': '10', Host: 'bucket.cos.accelerate.myqcloud.com' }, now: 1_790_000_000_000,
  };
  const signature = await cosAuthorization(input);
  assert.match(signature, /^q-sign-algorithm=sha1&q-ak=AKIDtest&q-sign-time=1789999940;1790000840&q-key-time=1789999940;1790000840&q-header-list=content-length;host&q-url-param-list=&q-signature=[0-9a-f]{40}$/u);
  assert.equal(await cosAuthorization(input), signature);
  assert.notEqual(await cosAuthorization({ ...input, secretKey: 'other' }), signature);
});

test('Makers 客户端用 globalThis 调 fetch（Workers 里挂成实例方法调用会 Illegal invocation）', async () => {
  const { MakersClient } = await import('../src/lib/makers-client.js');
  let receiver = null;
  const strictFetch = function strictFetch() {
    receiver = this;
    return Promise.resolve(Response.json({ Code: 0, Data: { Response: { Projects: [] } } }));
  };
  await new MakersClient('t', 'china', { fetchImpl: strictFetch }).findProject('x');
  assert.equal(receiver, globalThis);
});

test('输入校验：数据库连接串、加速区域、升级时可以不填数据库', () => {
  assert.equal(validateDatabaseUrl('postgres://u:p@db.example.com:5432/pay'), 'postgres://u:p@db.example.com:5432/pay');
  assert.throws(() => validateDatabaseUrl('mysql://u:p@db/x'), /格式不对/u);
  assert.throws(() => validateDatabaseUrl('postgres://u:p@127.0.0.1:5432/pay'), /本机地址/u);
  const base = {
    makersToken: 't', site: 'china', projectName: 'edgepay', edgepayLicense: 'EPL1.a.b', publicBaseUrl: 'https://pay.example.com',
  };
  assert.deepEqual(Object.keys(validateMakersInput({ ...base, mode: 'install' })).sort(), ['adminPassword', 'area', 'databaseUrl']);
  assert.deepEqual(validateMakersInput({ ...base, mode: 'upgrade' }), {});
  assert.deepEqual(Object.keys(validateMakersInput({ ...base, site: 'mars', mode: 'upgrade' })), ['makersToken']);
});

test('同名项目识别：直接上传类型且带 EdgePay 核心变量才算可升级', () => {
  const env = ['DATABASE_URL', 'ADMIN_TOKEN', 'CONFIG_ENCRYPTION_KEY'].map((Key) => ({ Key, Value: 'x' }));
  assert.equal(inspectMakersProject({ Provider: 'Upload', EnvVars: env }).compatible, true);
  assert.equal(inspectMakersProject({ Provider: 'Github', EnvVars: env }).compatible, false);
  assert.equal(inspectMakersProject({ Provider: 'Upload', EnvVars: env.slice(1) }).compatible, false);
  assert.deepEqual(inspectMakersProject(null), { exists: false, compatible: false });
});

// ---- 端到端：假的发行仓库 + 假的 Makers API + 假的 COS ----

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function releaseFiles({ withRuntime = true } = {}) {
  const files = {
    'core/index.js': "import './paid-plugins.js'; export default { fetch(){}, scheduled(){} };",
    'schema.sql': 'CREATE TABLE t (id INTEGER);',
    'bundled-assets.js': 'export function fetchBundledAsset() {}',
    'plugins/stripe_api.js': 'export default {};',
    'makers/runtime.js': 'export function createMakersHandler() {}',
  };
  const manifest = {
    release: '9.9.9',
    entry: 'index.js',
    entry_source: 'core/index.js',
    entry_sha256: await sha256Hex(files['core/index.js']),
    paid_plugins_module: 'paid-plugins.js',
    assets_module: 'bundled-assets.js',
    assets_source: 'bundled-assets.js',
    assets_sha256: await sha256Hex(files['bundled-assets.js']),
    schema: 'schema.sql',
    schema_sha256: await sha256Hex(files['schema.sql']),
    core_plugins: [],
    paid_plugins: [{ code: 'stripe_api', name: 'Stripe', path: 'plugins/stripe_api.js', sha256: await sha256Hex(files['plugins/stripe_api.js']) }],
    ...(withRuntime ? { makers: { runtime: 'makers/runtime.js', runtime_sha256: await sha256Hex(files['makers/runtime.js']) } } : {}),
  };
  files['COMMERCIAL_BUILD.json'] = JSON.stringify(manifest);
  return files;
}

function fakeMakers({ files, existing = null, deployStatuses = ['Process', 'Success'], logLines = [] }) {
  const state = {
    project: existing,
    envVars: existing ? [...existing.EnvVars] : [],
    actions: [],
    uploads: [],
    nextEnvId: 100,
  };
  const api = {
    DescribePagesProjects: () => ({ Projects: state.project ? [{ ...state.project, EnvVars: state.envVars }] : [] }),
    CreatePagesProject: (data) => {
      state.project = { ProjectId: 'makers-new', Name: data.Name, Provider: 'Upload', Area: data.Area, PresetDomain: 'edgepay-abc.edgeone.cool', CustomDomains: [] };
      return { ProjectId: 'makers-new' };
    },
    DescribePagesProjectEnvs: () => ({ EnvVars: state.envVars.map((item) => ({ ...item, Env: ['Production'] })) }),
    ModifyPagesProjectEnvs: (data) => {
      for (const item of data.EnvVars) {
        state.envVars = state.envVars.filter((current) => current.Key !== item.Key);
        state.envVars.push({ Id: item.Id ?? (state.nextEnvId += 1), Key: item.Key, Value: item.Value });
      }
      return {};
    },
    DeletePagesProjectEnvs: (data) => {
      state.envVars = state.envVars.filter((current) => !data.EnvVars.some((item) => item.Id === current.Id));
      return {};
    },
    DescribePagesCosTempToken: () => ({
      Bucket: 'eop-bucket-1', Region: 'ap-shanghai', TargetPath: '1/edgepay/123',
      Credentials: { TmpSecretId: 'AKIDtmp', TmpSecretKey: 'tmpkey', Token: 'tmptoken' },
    }),
    CreatePagesDeployment: (data) => {
      assert.equal(data.TempBucketPath, '1/edgepay/123/edgepay.zip');
      return { DeploymentId: 'dp-1' };
    },
    DescribePagesDeployments: () => ({ Deployments: [{ DeploymentId: 'dp-1', Status: deployStatuses.shift() ?? 'Success' }] }),
    DescribePagesDeploymentLog: () => ({ LogUrl: 'https://logs.example/build.log' }),
    DescribePagesEncipherToken: (data) => {
      assert.equal(data.Text, 'edgepay-abc.edgeone.cool');
      return { Token: 'preview-token', Timestamp: 1790000000 };
    },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://pages-api.cloud.tencent.com/v1') {
      assert.equal(init.headers.authorization, 'Bearer makers-token');
      const { Action, ...data } = JSON.parse(init.body);
      state.actions.push(Action);
      if (!api[Action]) return Response.json({ Code: 107, Message: 'Action has not found.' });
      return Response.json({ Code: 0, Data: { Response: api[Action](data) } });
    }
    if (url.startsWith('https://eop-bucket-1.cos.accelerate.myqcloud.com/')) {
      assert.match(init.headers.authorization, /^q-sign-algorithm=sha1&q-ak=AKIDtmp&/u);
      assert.equal(init.headers['x-cos-security-token'], 'tmptoken');
      state.uploads.push({ url, zip: readZip(init.body) });
      return new Response('', { status: 200 });
    }
    if (url.startsWith('https://api.github.com/')) {
      const path = decodeURIComponent(url.match(/\/contents\/(.+)\?ref=/u)[1]);
      return path in files ? new Response(files[path]) : new Response('not found', { status: 404 });
    }
    if (url === 'https://logs.example/build.log') {
      return new Response(logLines.map((line) => JSON.stringify({ t: 'i', ls: [[0, line]] })).join('\n'));
    }
    if (url === 'https://edgepay-abc.edgeone.cool/health') {
      // 默认域名没带预览凭证时 Makers 回 401 页面。
      return init.headers?.cookie === 'eo_token=preview-token; eo_time=1790000000'
        ? Response.json({ ok: true })
        : new Response('<html>401</html>', { status: 401, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`用例没有预料到的请求：${url}`);
  };
  return { state, fetchImpl };
}

const env = {
  TEMPLATE_OWNER: 'Suk-ldev', TEMPLATE_REPO: 'dist', TEMPLATE_COMMIT_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'gh',
};
const licenseOk = async () => ({ domain: 'pay.example.com', licenseId: 'lic', entitlements: ['stripe_api'] });

async function runDeploy(body, fake, options = {}) {
  const response = await handleMakersDeploy(new Request('https://deploy.example/api/makers/deploy', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, { fetchImpl: fake.fetchImpl, sleep: async () => {}, verifyLicenseImpl: licenseOk, ...options });
  return (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
}

const installBody = {
  makersToken: 'makers-token', site: 'china', projectName: 'edgepay', mode: 'install', area: 'global',
  databaseUrl: 'postgres://pay:secret@db.example.com:5432/pay', adminPassword: 'admin-password',
  publicBaseUrl: 'https://pay.example.com', edgepayLicense: `EPL1.${'p'.repeat(1_500)}.sig`,
};

test('新建部署：建项目、写变量、传 zip、等构建、查健康，完成页带 tick 地址和全部密钥', async () => {
  const fake = fakeMakers({ files: await releaseFiles() });
  const events = await runDeploy(installBody, fake);
  const done = events.at(-1);
  assert.equal(done.stage, 'complete', JSON.stringify(events.filter((event) => event.status === 'error')));

  assert.deepEqual(
    fake.state.actions.filter((action) => ['CreatePagesProject', 'DescribePagesCosTempToken', 'CreatePagesDeployment'].includes(action)),
    ['CreatePagesProject', 'DescribePagesCosTempToken', 'CreatePagesDeployment'],
  );
  const env = Object.fromEntries(fake.state.envVars.map((item) => [item.Key, item.Value]));
  assert.equal(env.DATABASE_URL, installBody.databaseUrl);
  assert.equal(env.PUBLIC_BASE_URL, 'https://pay.example.com');
  assert.equal(env.ADMIN_TOKEN, 'admin-password');
  for (const key of ['EPAY_KEY', 'POLL_TRIGGER_TOKEN', 'CONFIG_ENCRYPTION_KEY', 'WATCHER_TRANSPORT_SECRET']) {
    assert.match(env[key], /^[0-9a-f]{64}$/u, `${key} 必须是十六进制，免得被 Makers 过滤`);
  }
  assert.equal(env.EDGEPAY_LICENSE + env.EDGEPAY_LICENSE_2, installBody.edgepayLicense, 'License 超过 1000 字节要拆段');
  assert.ok(Object.values(env).every((value) => value.length <= 1_000));

  const [upload] = fake.state.uploads;
  assert.ok(upload.zip.has('edgepay/cloud-functions/_edgepay/core.js'));
  assert.ok(upload.zip.has('edgepay/cloud-functions/_edgepay/plugins/stripe_api.js'), '按权益装上已购插件');
  assert.match(upload.zip.get('edgepay/cloud-functions/_edgepay/paid-plugins.js').text, /stripe_api/u);

  assert.equal(done.result.tickUrl, `https://pay.example.com/internal/tick?token=${env.POLL_TRIGGER_TOKEN}`);
  assert.equal(done.result.presetUrl, 'https://edgepay-abc.edgeone.cool');
  assert.equal(done.result.previewAdminUrl, 'https://edgepay-abc.edgeone.cool/admin?eo_token=preview-token&eo_time=1790000000');
  assert.equal(done.result.domainBound, false);
  assert.equal(done.result.healthWarning, '');
  assert.equal(done.result.consoleUrl, 'https://console.cloud.tencent.com/edgeone/pages/project/makers-new');
  assert.equal(done.result.CONFIG_ENCRYPTION_KEY, env.CONFIG_ENCRYPTION_KEY);
  // 密钥写进项目那一刻就交给页面，后面失败了也能保存。
  assert.equal(events.find((event) => event.stage === 'env_config' && event.secrets)?.secrets.POLL_TRIGGER_TOKEN, env.POLL_TRIGGER_TOKEN);
  assert.ok(!JSON.stringify(events.filter((event) => event.stage !== 'complete' && !event.secrets)).includes('admin-password'));
});

test('无损升级：不建项目、不动密钥，只更新 License 并删掉多余的旧分段', async () => {
  const existing = {
    ProjectId: 'makers-old', Name: 'edgepay', Provider: 'Upload', Area: 'global',
    PresetDomain: 'edgepay-abc.edgeone.cool', CustomDomains: [],
    EnvVars: [
      { Id: 1, Key: 'DATABASE_URL', Value: 'postgres://old' },
      { Id: 2, Key: 'ADMIN_TOKEN', Value: 'old-admin' },
      { Id: 3, Key: 'CONFIG_ENCRYPTION_KEY', Value: 'old-key' },
      { Id: 4, Key: 'EDGEPAY_LICENSE', Value: 'EPL1.old' },
      { Id: 5, Key: 'EDGEPAY_LICENSE_2', Value: 'part2' },
      { Id: 6, Key: 'EDGEPAY_LICENSE_3', Value: 'part3' },
    ],
  };
  const fake = fakeMakers({ files: await releaseFiles(), existing });
  const events = await runDeploy({ ...installBody, mode: 'upgrade', adminPassword: undefined, databaseUrl: undefined, area: undefined }, fake);
  assert.equal(events.at(-1).stage, 'complete');
  assert.ok(!fake.state.actions.includes('CreatePagesProject'));
  const env = Object.fromEntries(fake.state.envVars.map((item) => [item.Key, item.Value]));
  assert.equal(env.DATABASE_URL, 'postgres://old');
  assert.equal(env.ADMIN_TOKEN, 'old-admin');
  assert.equal(env.CONFIG_ENCRYPTION_KEY, 'old-key');
  assert.equal(env.EDGEPAY_LICENSE + env.EDGEPAY_LICENSE_2, installBody.edgepayLicense);
  assert.equal(env.EDGEPAY_LICENSE_3, undefined, '新 License 只有两段，旧的第三段必须删掉');
  assert.equal(events.at(-1).result.tickUrl, '', '升级不展示轮询 Token（可能已在后台轮换过）');
});

test('新建时撞上同名 EdgePay 项目：返回 confirm_upgrade，不覆盖', async () => {
  const existing = {
    ProjectId: 'makers-old', Name: 'edgepay', Provider: 'Upload',
    EnvVars: ['DATABASE_URL', 'ADMIN_TOKEN', 'CONFIG_ENCRYPTION_KEY'].map((Key, Id) => ({ Id, Key, Value: 'x' })),
  };
  const fake = fakeMakers({ files: await releaseFiles(), existing });
  const events = await runDeploy(installBody, fake);
  const error = events.find((event) => event.status === 'error');
  assert.equal(error.stage, 'project_check');
  assert.equal(error.action, 'confirm_upgrade');
  assert.ok(!fake.state.actions.includes('ModifyPagesProjectEnvs'));
});

test('构建失败：带回构建日志末尾，之前生成的密钥已经交给页面', async () => {
  const fake = fakeMakers({
    files: await releaseFiles(),
    deployStatuses: ['Process', 'Failed'],
    logLines: ['Running "edgeone makers build"', '\u001b[31m✘ [ERROR] something broke\u001b[0m'],
  });
  const events = await runDeploy(installBody, fake);
  const error = events.find((event) => event.status === 'error');
  assert.equal(error.stage, 'deploy');
  assert.match(error.detail, /✘ \[ERROR\] something broke/u);
  assert.doesNotMatch(error.detail, /\u001b/u, '终端颜色码要去掉');
  assert.ok(events.some((event) => event.stage === 'env_config' && event.secrets?.ADMIN_TOKEN));
});

test('发行版本没有 Makers 运行时：在拉取阶段明确拒绝，不建项目', async () => {
  const fake = fakeMakers({ files: await releaseFiles({ withRuntime: false }) });
  const events = await runDeploy(installBody, fake);
  const error = events.find((event) => event.status === 'error');
  assert.equal(error.stage, 'template_fetch');
  assert.match(error.message, /不含 EdgeOne Makers 运行时/u);
  assert.ok(!fake.state.actions.includes('CreatePagesProject'));
});
