import { handleDeploy } from './deploy-handler.js';
import { handleVerifyToken } from './verify-token-handler.js';
import { handleVerifyLicense } from './verify-license-handler.js';
import { handleCheckProject } from './check-project-handler.js';

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
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return env.ASSETS.fetch(request);
}
