import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTemplateTree, isBinaryAsset } from '../src/lib/template-fetcher.js';

const fixtureTree = {
  tree: [
    { path: 'README.md', type: 'blob' },
    { path: 'LICENSE', type: 'blob' },
    { path: 'schema.sql', type: 'blob' },
    { path: 'wrangler.toml.example', type: 'blob' },
    { path: 'src', type: 'tree' },
    { path: 'src/index.js', type: 'blob' },
    { path: 'src/channels.js', type: 'blob' },
    { path: 'public', type: 'tree' },
    { path: 'public/index.html', type: 'blob' },
    { path: 'public/cashier', type: 'tree' },
    { path: 'public/cashier/index.html', type: 'blob' },
    { path: 'qa/design-qa.md', type: 'blob' },
    { path: 'agent/serverless-watcher/README.md', type: 'blob' },
  ],
};

test('只保留 src/**、public/** 和根目录 schema.sql', () => {
  const paths = filterTemplateTree(fixtureTree);
  assert.deepEqual(paths.sort(), [
    'public/cashier/index.html',
    'public/index.html',
    'schema.sql',
    'src/channels.js',
    'src/index.js',
  ]);
});

test('忽略 README、LICENSE、wrangler.toml.example、qa/、agent/ 等无关文件', () => {
  const paths = filterTemplateTree(fixtureTree);
  assert.ok(!paths.includes('README.md'));
  assert.ok(!paths.includes('LICENSE'));
  assert.ok(!paths.includes('wrangler.toml.example'));
  assert.ok(!paths.some((p) => p.startsWith('qa/')));
  assert.ok(!paths.some((p) => p.startsWith('agent/')));
});

test('忽略 tree 类型的条目（目录本身），只要 blob', () => {
  const paths = filterTemplateTree(fixtureTree);
  assert.ok(!paths.includes('src'));
  assert.ok(!paths.includes('public'));
});

test('空 tree 返回空数组', () => {
  assert.deepEqual(filterTemplateTree({ tree: [] }), []);
  assert.deepEqual(filterTemplateTree({}), []);
});

test('isBinaryAsset 识别图片扩展名', () => {
  assert.equal(isBinaryAsset('public/wechat.png'), true);
  assert.equal(isBinaryAsset('public/fubei.jpg'), true);
  assert.equal(isBinaryAsset('public/contact/default-avatar.png'), true);
  assert.equal(isBinaryAsset('src/index.js'), false);
  assert.equal(isBinaryAsset('public/styles.css'), false);
});
