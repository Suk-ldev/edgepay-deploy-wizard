import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { route } from '../src/router.js';

test('部署向导通过 imsuk.eu.org SaaS 区域接收 deploy.imsuk.cn', async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /pattern\s*=\s*"deploy\.imsuk\.cn\/\*"/u);
  assert.match(config, /zone_name\s*=\s*"imsuk\.eu\.org"/u);
  assert.match(config, /binding\s*=\s*"LICENSE_SERVICE"/u);
  assert.match(config, /service\s*=\s*"edgepay-license-worker"/u);
  // 唯一的 Custom Domain 是只开放版本接口的 deploy-api；部署入口仍然只有 deploy.imsuk.cn。
  assert.deepEqual(
    [...config.matchAll(/pattern\s*=\s*"([^"]+)"[^\n]*custom_domain\s*=\s*true/gu)].map((match) => match[1]),
    ['deploy-api.imsuk.eu.org'],
  );
  assert.doesNotMatch(config, /deploy\.imsuk\.eu\.org/u);
});

test('deploy-api 备用域名只回版本接口，页面和部署接口一律 404', async () => {
  const env = {
    TEMPLATE_VERSION: '2.1.15',
    TEMPLATE_COMMIT_SHA: 'e77de435b6e6e9396b6962afc073386fa4bf8f1a',
    TEMPLATE_MANIFEST_SHA256: '9c1e54828c9c86d340ec0b2357b8842324fa1845531218625a8239df9d9a8203',
    ASSETS: { fetch: () => new Response('<!doctype html>') },
  };
  const version = await route(new Request('https://deploy-api.imsuk.eu.org/api/latest-version'), env);
  assert.equal(version.status, 200);
  assert.equal((await version.json()).version, '2.1.15');
  for (const [path, init] of [
    ['/', {}],
    ['/guide', {}],
    ['/api/deploy', { method: 'POST', body: '{}' }],
    ['/api/verify-license', { method: 'POST', body: '{}' }],
  ]) {
    const response = await route(new Request(`https://deploy-api.imsuk.eu.org${path}`, init), env);
    assert.equal(response.status, 404, path);
  }
  const page = await route(new Request('https://deploy.imsuk.cn/'), env);
  assert.equal(page.status, 200, '正式入口不受影响');
});
