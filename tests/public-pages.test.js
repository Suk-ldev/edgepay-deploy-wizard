import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('部署站点包含图标、License 获取入口和 Docker 教程', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const guide = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');
  const icon = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  assert.match(index, /rel="icon" href="\/favicon\.svg"/u);
  assert.match(index, /https:\/\/license\.imsuk\.cn/u);
  assert.match(index, /id="edgepayLicense"[^>]+required/u);
  assert.doesNotMatch(index, /免费版可留空|免费插件时可留空/u);
  assert.match(index, /\/guide\.html/u);
  assert.match(guide, /ghcr\.io\/suk-ldev\/edgepay-watcher:latest/u);
  assert.match(guide, /WATCHER_TRANSPORT_SECRET/u);
  assert.match(icon, /<svg/u);
});
