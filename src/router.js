import { handleDeploy } from './deploy-handler.js';
import { handleVerifyToken } from './verify-token-handler.js';
import { handleVerifyLicense } from './verify-license-handler.js';
import { handleCheckProject } from './check-project-handler.js';
import { handleLatestVersion } from './latest-version-handler.js';
import { handleWatcherVersion } from './watcher-version-handler.js';
import { handleMakersCheckProject, handleMakersDeploy, handleMakersVerifyToken } from './makers-handlers.js';

// Static Assets canonicalizes /guide.html to /guide; both paths must use fresh content.
const NO_STORE_ASSETS = new Set(['/', '/index.html', '/wizard.js', '/makers-wizard.js', '/wizard.css', '/guide', '/guide.html', '/guide.css', '/guide.js']);

// 模块管理器（KernelSU / APatch / Magisk）拉 update.json 和 changelog 的超时很短，
// 且这两个文件直接呈现在更新 UI 上——content-type 必须明确（changelog 要纯文本，
// 给 HTML 会被当成解析失败报 timeout），响应头加上边缘缓存，重复拉取从最近的
// POP 直接回，不再受单次请求抖动影响。
const MODULE_UPDATE_ASSETS = new Map([
  ['/edgepay-node-update.json', 'application/json; charset=utf-8'],
  ['/edgepay-node-changelog.txt', 'text/plain; charset=utf-8'],
]);

async function serveAsset(request, env, pathname) {
  const response = await env.ASSETS.fetch(request);
  if (MODULE_UPDATE_ASSETS.has(pathname)) {
    const headers = new Headers(response.headers);
    headers.set('Content-Type', MODULE_UPDATE_ASSETS.get(pathname));
    headers.set('Cache-Control', 'public, max-age=300, s-maxage=86400');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!NO_STORE_ASSETS.has(pathname)) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound() {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function route(request, env) {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/api/deploy') {
    return handleDeploy(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/verify-token') {
    return handleVerifyToken(request);
  }
  if (request.method === 'POST' && url.pathname === '/api/verify-license') {
    return handleVerifyLicense(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/check-project') {
    return handleCheckProject(request);
  }
  if (request.method === 'GET' && url.pathname === '/api/latest-version') {
    return handleLatestVersion(env);
  }
  if (request.method === 'GET' && url.pathname === '/api/watcher-version') {
    return handleWatcherVersion(env);
  }
  if (request.method === 'POST' && url.pathname === '/api/makers/verify-token') {
    return handleMakersVerifyToken(request);
  }
  if (request.method === 'POST' && url.pathname === '/api/makers/check-project') {
    return handleMakersCheckProject(request);
  }
  if (request.method === 'POST' && url.pathname === '/api/makers/deploy') {
    return handleMakersDeploy(request, env);
  }
  if (url.pathname.startsWith('/api/')) return notFound();

  return serveAsset(request, env, url.pathname);
}
