import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchTemplateFiles,
  filterTemplatePaths,
  stripTemplateSubdir,
  stripTopLevelDir,
} from '../src/lib/template-fetcher.js';

const fixturePaths = [
  'README.md',
  'LICENSE',
  'schema.sql',
  'wrangler.toml.example',
  'src/index.js',
  'src/channels.js',
  'public/index.html',
  'public/cashier/index.html',
  'qa/design-qa.md',
  'agent/serverless-watcher/README.md',
];

test('只保留内嵌资源后的 src/** 和根目录 schema.sql', () => {
  const paths = filterTemplatePaths(fixturePaths);
  assert.deepEqual(paths.sort(), [
    'schema.sql',
    'src/channels.js',
    'src/index.js',
  ]);
});

test('忽略 README、LICENSE、wrangler.toml.example、qa/、agent/ 等无关文件', () => {
  const paths = filterTemplatePaths(fixturePaths);
  assert.ok(!paths.includes('README.md'));
  assert.ok(!paths.includes('LICENSE'));
  assert.ok(!paths.includes('wrangler.toml.example'));
  assert.ok(!paths.some((p) => p.startsWith('qa/')));
  assert.ok(!paths.some((p) => p.startsWith('agent/')));
});

test('空列表返回空数组', () => {
  assert.deepEqual(filterTemplatePaths([]), []);
});

test('stripTopLevelDir 去掉 GitHub tarball 最外层目录名', () => {
  assert.equal(stripTopLevelDir('edgepay-serverless-payment-abc123/src/index.js'), 'src/index.js');
  assert.equal(stripTopLevelDir('edgepay-serverless-payment-abc123/'), '');
  assert.equal(stripTopLevelDir('edgepay-serverless-payment-abc123'), '');
});

test('stripTemplateSubdir 支持从合并仓库读取 payment-worker 模板', () => {
  assert.equal(stripTemplateSubdir('payment-worker/src/index.js', 'payment-worker'), 'src/index.js');
  assert.equal(stripTemplateSubdir('payment-worker/schema.sql', '/payment-worker/'), 'schema.sql');
  assert.equal(stripTemplateSubdir('watcher/watcher.mjs', 'payment-worker'), '');
  assert.equal(stripTemplateSubdir('src/index.js'), 'src/index.js');
});

test('私有模板通过 GitHub API 携带 Secret Token 获取固定 commit', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response('', { status: 404 });
  };
  await assert.rejects(
    fetchTemplateFiles({
      owner: 'OWNER', repo: 'REPO', sha: 'COMMIT_SHA', githubToken: 'TOKEN_VALUE', fetchImpl,
    }),
    /GitHub 返回 404/u,
  );
  assert.equal(captured.url, 'https://api.github.com/repos/OWNER/REPO/tarball/COMMIT_SHA');
  assert.equal(captured.options.headers.authorization, 'Bearer TOKEN_VALUE');
  assert.equal(captured.options.redirect, 'follow');
});
