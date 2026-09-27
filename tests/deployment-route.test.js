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
  // 唯一的 Custom Domain 是 deploy-api：同 zone 的支付站检查更新靠它（路由上的 deploy.imsuk.cn 会 522）。
  assert.deepEqual(
    [...config.matchAll(/pattern\s*=\s*"([^"]+)"[^\n]*custom_domain\s*=\s*true/gu)].map((match) => match[1]),
    ['deploy-api.imsuk.eu.org'],
  );
  assert.doesNotMatch(config, /deploy\.imsuk\.eu\.org/u);
});

test('deploy-api 与 deploy.imsuk.cn 是同一个完整入口', async () => {
  const env = {
    TEMPLATE_VERSION: '2.1.16',
    TEMPLATE_COMMIT_SHA: 'e77de435b6e6e9396b6962afc073386fa4bf8f1a',
    TEMPLATE_MANIFEST_SHA256: '9c1e54828c9c86d340ec0b2357b8842324fa1845531218625a8239df9d9a8203',
    ASSETS: { fetch: () => new Response('<!doctype html>') },
  };
  for (const host of ['deploy.imsuk.cn', 'deploy-api.imsuk.eu.org']) {
    const version = await route(new Request(`https://${host}/api/latest-version`), env);
    assert.equal((await version.json()).version, '2.1.16', host);
    assert.equal((await route(new Request(`https://${host}/`), env)).status, 200, host);
  }
});
