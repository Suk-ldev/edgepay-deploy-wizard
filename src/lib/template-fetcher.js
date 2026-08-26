import { DeployError } from './errors.js';

/**
 * 从私有发行仓库拉取商业构建产物，并按 License 权益挑选付费插件模块。
 *
 * 产物形状（由私有 CI 生成）：
 *   COMMERCIAL_BUILD.json   构建清单，含每个文件的 SHA-256
 *   core/index.js           程序本体 + 免费插件 + License Gate
 *   plugins/<code>.js       每个付费插件一个自包含模块
 *   schema.sql
 *
 * **插件集合一律来自 License Worker 的签名响应，绝不接受客户端传入。**
 * 客户没买的插件，其代码根本不会被下载、更不会进入客户的 Worker——
 * 这比"全都打进去再靠运行时校验"硬得多。
 *
 * 发行仓库是私有的：只走带 token 的 GitHub Contents API，
 * 不回退 jsDelivr 或匿名 raw（那两条路对私有仓本来就取不到，
 * 留着只会把"token 配错"变成一个含糊的 404）。
 */

const SHA_RE = /^[a-f0-9]{40}$/iu;
const HASH_RE = /^[a-f0-9]{64}$/iu;
const MANIFEST_PATH = 'COMMERCIAL_BUILD.json';
// 一次部署最多拉这么多付费模块，避免清单被改坏时无限拉取。
const MAX_PLUGIN_MODULES = 64;

function encodePath(path) {
  return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function templatePath(path, subdir = '') {
  const root = String(subdir).replace(/^\/+|\/+$/gu, '');
  return root ? `${root}/${path}` : path;
}

async function fetchPrivateFile({ owner, repo, sha, path, githubToken, fetchImpl }) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    + `/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`;
  let response;
  try {
    response = await Reflect.apply(fetchImpl, globalThis, [url, {
      headers: {
        'user-agent': 'edgepay-deploy-wizard',
        accept: 'application/vnd.github.raw',
        authorization: `Bearer ${githubToken}`,
      },
      redirect: 'follow',
    }]);
  } catch (error) {
    throw new DeployError('template_fetch', `拉取发行文件 ${path} 网络失败，可以直接重试`, {
      retryable: true,
      detail: String(error),
    });
  }
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    const hint = response.status === 404
      ? '检查 TEMPLATE_COMMIT_SHA 与发行仓库路径'
      : response.status === 401 || response.status === 403
        ? '检查 GITHUB_TOKEN 是否有该私有仓库的只读权限'
        : '';
    throw new DeployError('template_fetch', `拉取发行文件 ${path} 失败（HTTP ${response.status}）${hint ? `，${hint}` : ''}`, {
      retryable,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) {
    throw new DeployError('template_fetch', `发行文件 ${path} 是空的，已停止部署`, { retryable: false });
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function assertHash(path, bytes, expected) {
  const want = String(expected ?? '').trim().toLowerCase();
  if (!want) {
    throw new DeployError('template_fetch', `构建清单里没有 ${path} 的 SHA-256，已停止部署`, { retryable: false });
  }
  if (!HASH_RE.test(want)) {
    throw new DeployError('template_fetch', `${path} 的 SHA-256 格式不合法`, { retryable: false });
  }
  const actual = await sha256Hex(bytes);
  if (actual !== want) {
    throw new DeployError('template_fetch', `${path} 完整性校验失败，停止部署`, {
      retryable: false,
      detail: `expected=${want}; actual=${actual}`,
    });
  }
}

const decoder = new TextDecoder();

/**
 * 生成权益胶水模块。核心以 `import { paidPlugins } from './paid-plugins.js'`
 * 静态引用它，构建时被标为 external，运行时由这里补齐。
 *
 * 用序号做标识符，不用插件编码——编码虽然目前都是合法标识符，
 * 但没必要让这里的正确性依赖那个约定。
 */
export function buildPaidPluginsModule(plugins) {
  if (!plugins.length) {
    return '// 该 License 没有付费插件权益。\nexport const paidPlugins = [];\n';
  }
  const lines = [
    '// 由部署向导按 License 权益生成。只包含该 License 已购买的插件。',
    '',
  ];
  plugins.forEach((plugin, index) => {
    lines.push(`import p${index} from './plugins/${plugin.code}.js';`);
  });
  lines.push('');
  lines.push(`export const paidPlugins = [${plugins.map((_, index) => `p${index}`).join(', ')}];`);
  lines.push('');
  return lines.join('\n');
}

/**
 * @param entitlements License Worker 返回的已购插件编码（服务端权威）
 * @returns 可直接交给 uploadWorkerScript 的 sourceFiles，以及 schema 与安装摘要
 */
export async function fetchCommercialRelease({
  owner,
  repo,
  sha,
  subdir = '',
  githubToken = '',
  manifestSha256 = '',
  entitlements = [],
  fetchImpl = fetch,
}) {
  if (!SHA_RE.test(String(sha ?? ''))) {
    throw new DeployError('template_fetch', 'TEMPLATE_COMMIT_SHA 必须是完整的 40 位 commit SHA', { retryable: false });
  }
  if (!String(githubToken ?? '').trim()) {
    throw new DeployError('template_fetch', '发行仓库是私有的，必须配置 GITHUB_TOKEN 才能部署', { retryable: false });
  }

  const get = (path) => fetchPrivateFile({
    owner, repo, sha, path: templatePath(path, subdir), githubToken, fetchImpl,
  });

  // 1) 构建清单本身也要固定住，否则后面所有哈希校验都失去锚点。
  const manifestBytes = await get(MANIFEST_PATH);
  if (String(manifestSha256 ?? '').trim()) {
    await assertHash(MANIFEST_PATH, manifestBytes, manifestSha256);
  }
  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
  } catch {
    throw new DeployError('template_fetch', '构建清单不是合法 JSON，已停止部署', { retryable: false });
  }

  const catalog = Array.isArray(manifest.paid_plugins) ? manifest.paid_plugins : [];
  const byCode = new Map(catalog.map((plugin) => [String(plugin.code), plugin]));

  // 2) 权益 ∩ 本次发行实际产出的付费模块。
  //    免费插件已经打在核心包里，不是"待安装"，要先排除掉——否则一个只有免费
  //    权益的 License 会被误报成"6 个已购插件尚未提供"。
  //    真正需要报出来的只有：买了付费插件、但这次发行还没打包它（例如刚上架）。
  const corePlugins = new Set(manifest.core_plugins ?? []);
  const wanted = [...new Set(entitlements.map(String))];
  const selected = wanted.filter((code) => byCode.has(code)).map((code) => byCode.get(code));
  const unavailable = wanted.filter((code) => !byCode.has(code) && !corePlugins.has(code));
  if (selected.length > MAX_PLUGIN_MODULES) {
    throw new DeployError('template_fetch', '权益里的付费插件数量异常，已停止部署', { retryable: false });
  }

  // 3) 核心与 schema
  const coreBytes = await get(manifest.entry_source ?? 'core/index.js');
  await assertHash('core/index.js', coreBytes, manifest.entry_sha256);
  const schemaBytes = await get(manifest.schema ?? 'schema.sql');
  await assertHash('schema.sql', schemaBytes, manifest.schema_sha256);

  // 4) 只下载已购插件的模块，逐个校验哈希
  const sourceFiles = [
    { path: manifest.entry ?? 'index.js', content: decoder.decode(coreBytes) },
  ];
  for (const plugin of selected) {
    const bytes = await get(plugin.path);
    await assertHash(plugin.path, bytes, plugin.sha256);
    sourceFiles.push({ path: `plugins/${plugin.code}.js`, content: decoder.decode(bytes) });
  }

  // 5) 胶水模块在本地生成，不需要也不应该从远端取
  sourceFiles.push({
    path: manifest.paid_plugins_module ?? 'paid-plugins.js',
    content: buildPaidPluginsModule(selected),
  });

  return {
    manifest,
    schemaText: decoder.decode(schemaBytes),
    sourceFiles,
    installed: selected.map((plugin) => ({ code: plugin.code, name: plugin.name, version: plugin.version })),
    unavailable,
  };
}
