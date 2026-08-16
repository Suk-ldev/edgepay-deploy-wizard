import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assetContentHash, buildAssetManifest } from '../src/lib/manifest-hash.js';

function referenceHash(bytes) {
  const full = createHash('sha256').update(Buffer.from(bytes)).digest();
  return full.subarray(0, 16).toString('hex');
}

test('assetContentHash 是 sha256 前 16 字节的 32 位 hex，和参考实现一致', async () => {
  const bytes = new TextEncoder().encode('hello edgepay');
  const hash = await assetContentHash(bytes);
  assert.equal(hash.length, 32);
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(hash, referenceHash(bytes));
});

test('空内容也能正常算出稳定的 hash', async () => {
  const bytes = new Uint8Array(0);
  const hash = await assetContentHash(bytes);
  assert.equal(hash, referenceHash(bytes));
});

test('buildAssetManifest 给路径补前导斜杠，附带 size', async () => {
  const files = [
    { path: 'index.html', bytes: new TextEncoder().encode('<html></html>') },
    { path: '/cashier/assets/cashier.js', bytes: new TextEncoder().encode('console.log(1)') },
  ];
  const manifest = await buildAssetManifest(files);

  assert.deepEqual(Object.keys(manifest).sort(), ['/cashier/assets/cashier.js', '/index.html']);
  assert.equal(manifest['/index.html'].size, files[0].bytes.byteLength);
  assert.equal(manifest['/index.html'].hash, referenceHash(files[0].bytes));
});
