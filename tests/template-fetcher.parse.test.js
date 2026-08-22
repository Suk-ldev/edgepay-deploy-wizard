import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTemplateFiles } from '../src/lib/template-fetcher.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const encoder = new TextEncoder();

function ok(text) {
  return new Response(encoder.encode(text), { status: 200 });
}

test('固定 commit 只拉取商业发行所需的 schema 和单文件 Worker', async () => {
  const urls = [];
  const files = await fetchTemplateFiles({
    owner: 'OWNER', repo: 'REPO', sha: SHA,
    fetchImpl: async (url) => { urls.push(url); return ok(url.endsWith('schema.sql') ? 'schema' : 'worker'); },
  });
  assert.deepEqual(files.map((file) => file.path), ['schema.sql', 'src/index.js']);
  assert.deepEqual(files.map((file) => new TextDecoder().decode(file.bytes)), ['schema', 'worker']);
  assert.deepEqual(urls, [
    `https://cdn.jsdelivr.net/gh/OWNER/REPO@${SHA}/schema.sql`,
    `https://cdn.jsdelivr.net/gh/OWNER/REPO@${SHA}/src/index.js`,
  ]);
});

test('调用 Worker 全局 fetch 时保留正确的 globalThis 接收者', async () => {
  let calls = 0;
  const files = await fetchTemplateFiles({
    owner: 'OWNER', repo: 'REPO', sha: SHA,
    fetchImpl: function (url) {
      assert.equal(this, globalThis);
      calls += 1;
      return Promise.resolve(ok(url.endsWith('schema.sql') ? 'schema' : 'worker'));
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(files.map((file) => new TextDecoder().decode(file.bytes)), ['schema', 'worker']);
});

test('jsDelivr 失败时回退到 GitHub Raw，不再下载 tarball', async () => {
  const requests = [];
  const files = await fetchTemplateFiles({
    owner: 'OWNER', repo: 'REPO', sha: SHA, githubToken: 'TOKEN_VALUE',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('cdn.jsdelivr.net')) return new Response('', { status: 504 });
      return ok(url.endsWith('schema.sql') ? 'schema' : 'worker');
    },
  });
  assert.equal(files.length, 2);
  assert.equal(requests.length, 4);
  assert.equal(requests[1].url, `https://raw.githubusercontent.com/OWNER/REPO/${SHA}/schema.sql`);
  assert.equal(requests[1].options.headers.authorization, 'Bearer TOKEN_VALUE');
  assert.ok(requests.every(({ url }) => !url.includes('/tarball/')));
});

test('双源都失败时给出可重试错误', async () => {
  await assert.rejects(
    fetchTemplateFiles({
      owner: 'OWNER', repo: 'REPO', sha: SHA,
      fetchImpl: async () => new Response('', { status: 504 }),
    }),
    (error) => error.stage === 'template_fetch' && error.retryable && /jsDelivr 返回 504/u.test(error.message),
  );
});

test('完整 SHA 和文件哈希不匹配时停止部署', async () => {
  await assert.rejects(
    fetchTemplateFiles({
      owner: 'OWNER', repo: 'REPO', sha: SHA,
      expectedHashes: { 'schema.sql': '0'.repeat(64) },
      fetchImpl: async (url) => ok(url.endsWith('schema.sql') ? 'schema' : 'worker'),
    }),
    /完整性校验失败/u,
  );
  await assert.rejects(
    fetchTemplateFiles({ owner: 'OWNER', repo: 'REPO', sha: 'main', fetchImpl: async () => ok('x') }),
    /40 位 commit SHA/u,
  );
});

test('合并仓库子目录会加入远程文件路径，但返回部署路径保持不变', async () => {
  const urls = [];
  const files = await fetchTemplateFiles({
    owner: 'OWNER', repo: 'REPO', sha: SHA, subdir: '/payment-worker/',
    fetchImpl: async (url) => { urls.push(url); return ok('content'); },
  });
  assert.ok(urls.every((url) => url.includes('/payment-worker/')));
  assert.deepEqual(files.map((file) => file.path), ['schema.sql', 'src/index.js']);
});
