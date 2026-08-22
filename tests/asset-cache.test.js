import assert from 'node:assert/strict';
import test from 'node:test';
import { route } from '../src/router.js';

test('部署向导入口和脚本禁止浏览器继续使用旧版本缓存', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('asset', { headers: { 'Cache-Control': 'public, max-age=3600' } }),
    },
  };
  for (const path of ['/', '/index.html', '/wizard.js', '/wizard.css', '/guide.html']) {
    const response = await route(new Request(`https://deploy.example${path}`), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('带内容哈希的其他静态资源保留平台缓存策略', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('asset', { headers: { 'Cache-Control': 'public, max-age=3600' } }),
    },
  };
  const response = await route(new Request('https://deploy.example/favicon.svg'), env);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
});
