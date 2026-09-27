/**
 * EdgeOne Makers 部署包的文件布局。
 *
 * 部署站（在 Worker 里打 zip 上传）和本地打包脚本（payment-makers/scripts/build-makers.mjs）
 * 共用这一份，两条路部署出来的东西完全一样：
 *
 *   package.json / edgeone.json         声明 ESM；云函数超时 60 秒
 *   cloud-functions/[[default]].js      除根路径外的所有路径
 *   cloud-functions/index.js            根路径 `/`（[[default]] 匹配不到它）
 *   cloud-functions/_edgepay/app.js     组装入口：核心 + Makers 运行时
 *   cloud-functions/_edgepay/core.js    商业发行的核心（CF 版叫 index.js，同一份文件）
 *   cloud-functions/_edgepay/runtime.js Makers 平台层（含 pg 驱动），发行时单独打包
 *   cloud-functions/_edgepay/…          paid-plugins.js、plugins/<code>.js、bundled-assets.js
 *
 * 几条是在 Makers 上踩出来的：路由文件只能写成两行转发（平台构建会把路由源码拼进同一个
 * 入口再改写 onRequest 导出）；核心不能叫 index.js（子目录的 index.js 会被当成路由）；
 * 应用实例挂在 globalThis 上（平台每个请求都重新执行一遍模块，只有进程和 globalThis 复用）。
 */

export const MAKERS_PACKAGE_ROOT = 'edgepay';
export const MAKERS_MAX_DURATION_SECONDS = 60;
const APP_DIR = 'cloud-functions/_edgepay';
const APP_EXPORT = 'handleEdgepayRequest';

function routeModule(comment) {
  return [
    `// ${comment}`,
    `import { ${APP_EXPORT} } from './_edgepay/app.js';`,
    '',
    'export function onRequest(context) {',
    `  return ${APP_EXPORT}(context);`,
    '}',
    '',
  ].join('\n');
}

const APP_MODULE = [
  "import worker from './core.js';",
  "import { createMakersHandler } from './runtime.js';",
  '',
  '// 平台每个请求都重新执行一遍模块，但进程和 globalThis 复用：所有请求共用第一次初始化的',
  '// 那份应用，连接池和核心里的短时缓存（运行时密钥、License Grant）这才能跨请求生效。',
  "const shared = Symbol.for('edgepay.makers.handler');",
  `export const ${APP_EXPORT} = globalThis[shared] ??= createMakersHandler(worker);`,
  '',
].join('\n');

/**
 * @param sourceFiles 与 Cloudflare 部署相同的模块列表（fetchCommercialRelease 的 sourceFiles）
 * @param entry       其中核心模块的路径（发行清单的 entry，默认 index.js）
 * @param runtimeSource Makers 运行时（发行目录 makers/runtime.js）的源码
 * @returns 相对部署包根目录的文件列表
 */
export function makersPackageFiles({ sourceFiles, entry = 'index.js', runtimeSource }) {
  if (!String(runtimeSource ?? '').trim()) throw new Error('缺少 Makers 运行时，无法组装部署包');
  if (!sourceFiles.some((file) => file.path === entry)) throw new Error(`部署模块里没有核心入口 ${entry}`);
  const files = [
    { path: 'package.json', content: `${JSON.stringify({ name: 'edgepay-payment-makers', private: true, type: 'module' }, null, 2)}\n` },
    { path: 'edgeone.json', content: `${JSON.stringify({ cloudFunctions: { maxDuration: MAKERS_MAX_DURATION_SECONDS } }, null, 2)}\n` },
    { path: 'cloud-functions/[[default]].js', content: routeModule('除根路径外的所有路径。') },
    { path: 'cloud-functions/index.js', content: routeModule('根路径 `/`：[[default]] 只匹配至少一段路径。') },
    { path: `${APP_DIR}/app.js`, content: APP_MODULE },
    { path: `${APP_DIR}/runtime.js`, content: runtimeSource },
  ];
  for (const file of sourceFiles) {
    const relative = String(file.path).replace(/^\/+/u, '');
    if (!relative || relative.includes('..')) throw new Error(`部署模块路径不合法：${file.path}`);
    files.push({ path: `${APP_DIR}/${relative === entry ? 'core.js' : relative}`, content: file.content });
  }
  return files;
}
