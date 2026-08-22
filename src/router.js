import { handleDeploy } from './deploy-handler.js';
import { handleVerifyToken } from './verify-token-handler.js';
import { handleVerifyLicense } from './verify-license-handler.js';
import { handleCheckProject } from './check-project-handler.js';
import { handleLatestVersion } from './latest-version-handler.js';

const NO_STORE_ASSETS = new Set(['/', '/index.html', '/wizard.js', '/wizard.css', '/guide.html']);

async function serveAsset(request, env, pathname) {
  const response = await env.ASSETS.fetch(request);
  if (!NO_STORE_ASSETS.has(pathname)) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
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
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return serveAsset(request, env, url.pathname);
}
