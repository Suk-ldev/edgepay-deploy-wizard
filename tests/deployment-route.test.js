import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('部署向导通过 imsuk.eu.org SaaS 区域接收 deploy.imsuk.cn', async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /pattern\s*=\s*"deploy\.imsuk\.cn\/\*"/u);
  assert.match(config, /zone_name\s*=\s*"imsuk\.eu\.org"/u);
  assert.match(config, /binding\s*=\s*"LICENSE_SERVICE"/u);
  assert.match(config, /service\s*=\s*"edgepay-license-worker"/u);
  assert.doesNotMatch(config, /custom_domain\s*=\s*true/u);
  assert.doesNotMatch(config, /deploy\.imsuk\.eu\.org/u);
});
