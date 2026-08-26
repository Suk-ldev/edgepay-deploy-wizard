import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { buildPaidPluginsModule, fetchCommercialRelease } from '../src/lib/template-fetcher.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const encoder = new TextEncoder();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const SHA = 'a'.repeat(40);

/** 造一份完整的发行产物，并返回一个按路径应答的假 fetch。 */
async function makeRelease({ paidPlugins = ['stripe_api', 'paypal_api'] } = {}) {
  const files = {
    'core/index.js': 'export default { fetch(){}, scheduled(){} };',
    'schema.sql': 'CREATE TABLE payment_attempts (id INTEGER);',
  };
  const catalog = [];
  for (const code of paidPlugins) {
    const path = `plugins/${code}.js`;
    files[path] = `export default { manifest: { code: '${code}' } };`;
    catalog.push({
      code,
      name: code.toUpperCase(),
      version: '1.0.0',
      tier: 'PAID',
      path,
      sha256: await sha256Hex(files[path]),
    });
  }
  const manifest = {
    release: '2.0.0',
    build_id: 'core-commercial',
    entry: 'index.js',
    entry_source: 'core/index.js',
    entry_sha256: await sha256Hex(files['core/index.js']),
    paid_plugins_module: 'paid-plugins.js',
    schema: 'schema.sql',
    schema_sha256: await sha256Hex(files['schema.sql']),
    core_plugins: ['wxpay_receipt', 'alipay_receipt', 'alipay_api', 'wechat_api', 'shouqianba_receipt', 'fubei_receipt'],
    paid_plugins: catalog,
  };
  files['COMMERCIAL_BUILD.json'] = JSON.stringify(manifest);

  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const match = decodeURIComponent(String(url)).match(/\/contents\/(.+)\?ref=/u);
    const path = match ? match[1] : '';
    if (!(path in files)) return new Response('not found', { status: 404 });
    return new Response(files[path], { status: 200 });
  };
  return { files, manifest, fetchImpl, requested };
}

const base = { owner: 'o', repo: 'r', sha: SHA, githubToken: 'gh_token' };

test('只下载 License 买过的付费插件模块，没买的连请求都不会发出', async () => {
  const { fetchImpl, requested } = await makeRelease();
  const result = await fetchCommercialRelease({
    ...base,
    entitlements: ['stripe_api', 'wxpay_receipt'],
    fetchImpl,
  });

  const paths = result.sourceFiles.map((file) => file.path).sort();
  assert.deepEqual(paths, ['index.js', 'paid-plugins.js', 'plugins/stripe_api.js']);
  assert.deepEqual(result.installed.map((plugin) => plugin.code), ['stripe_api']);
  // 关键性质：没买的插件代码根本没被取回来，谈不上进客户的 Worker。
  assert.ok(!requested.some((url) => url.includes('paypal_api')));
});

test('胶水模块只 import 已购插件并导出 paidPlugins', async () => {
  const { fetchImpl } = await makeRelease();
  const result = await fetchCommercialRelease({
    ...base,
    entitlements: ['paypal_api', 'stripe_api'],
    fetchImpl,
  });
  const glue = result.sourceFiles.find((file) => file.path === 'paid-plugins.js').content;
  assert.match(glue, /import p0 from '\.\/plugins\/paypal_api\.js';/u);
  assert.match(glue, /import p1 from '\.\/plugins\/stripe_api\.js';/u);
  assert.match(glue, /export const paidPlugins = \[p0, p1\];/u);
});

test('没有付费权益时仍生成空胶水模块，核心的静态 import 不会断', () => {
  const glue = buildPaidPluginsModule([]);
  assert.match(glue, /export const paidPlugins = \[\];/u);
  assert.doesNotMatch(glue, /import/u);
});

test('任一产物哈希对不上立即停止部署', async () => {
  const { files, fetchImpl } = await makeRelease();
  files['plugins/stripe_api.js'] = 'export default { tampered: true };';
  await assert.rejects(
    fetchCommercialRelease({ ...base, entitlements: ['stripe_api'], fetchImpl }),
    /完整性校验失败/u,
  );
});

test('构建清单本身也被钉住，被替换时拒绝部署', async () => {
  const { fetchImpl } = await makeRelease();
  await assert.rejects(
    fetchCommercialRelease({
      ...base,
      entitlements: [],
      manifestSha256: 'b'.repeat(64),
      fetchImpl,
    }),
    /完整性校验失败/u,
  );
});

test('发行仓库是私有的：缺 Token 直接报错，不回退匿名源', async () => {
  const { fetchImpl, requested } = await makeRelease();
  await assert.rejects(
    fetchCommercialRelease({ ...base, githubToken: '', entitlements: [], fetchImpl }),
    /必须配置 GITHUB_TOKEN/u,
  );
  assert.equal(requested.length, 0);
});

test('只走 GitHub Contents API，不使用 jsDelivr 或匿名 raw', async () => {
  const { fetchImpl, requested } = await makeRelease();
  await fetchCommercialRelease({ ...base, entitlements: ['stripe_api'], fetchImpl });
  assert.ok(requested.every((url) => url.startsWith('https://api.github.com/repos/')));
  assert.ok(!requested.some((url) => url.includes('jsdelivr') || url.includes('raw.githubusercontent')));
});

test('免费插件权益不算"待安装"——它们本来就在核心包里', async () => {
  // License 的权益里同时含免费和付费编码。免费的已经打进 core/index.js，
  // 不该被报成"已购但当前发行未提供"，否则只买免费版的客户会看到一条假警告。
  const { fetchImpl } = await makeRelease({ paidPlugins: ['stripe_api'] });
  const result = await fetchCommercialRelease({
    ...base,
    entitlements: ['wxpay_receipt', 'alipay_api', 'stripe_api'],
    fetchImpl,
  });
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.installed.map((plugin) => plugin.code), ['stripe_api']);
});

test('买了但当前发行版本还没打包的插件，如实报出而不是静默跳过', async () => {
  const { fetchImpl } = await makeRelease({ paidPlugins: ['stripe_api'] });
  const result = await fetchCommercialRelease({
    ...base,
    entitlements: ['stripe_api', 'usdt_trc20_receipt'],
    fetchImpl,
  });
  assert.deepEqual(result.unavailable, ['usdt_trc20_receipt']);
  assert.deepEqual(result.installed.map((plugin) => plugin.code), ['stripe_api']);
});

test('commit SHA 必须是完整 40 位', async () => {
  const { fetchImpl } = await makeRelease();
  await assert.rejects(
    fetchCommercialRelease({ ...base, sha: 'main', entitlements: [], fetchImpl }),
    /40 位 commit SHA/u,
  );
});
