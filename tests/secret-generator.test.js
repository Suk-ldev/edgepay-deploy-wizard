import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecret, generateDeploySecrets } from '../src/lib/secret-generator.js';

test('生成的密钥是不带填充的 base64url', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Za-z0-9_-]+$/);
  assert.ok(!secret.includes('+'));
  assert.ok(!secret.includes('/'));
  assert.ok(!secret.includes('='));
});

test('32 字节随机数编码后长度稳定在 43 个字符', () => {
  // base64url(32 bytes) 去掉填充后固定是 43 个字符
  const secret = generateSecret();
  assert.equal(secret.length, 43);
});

test('多次生成互不相同', () => {
  const values = new Set(Array.from({ length: 50 }, () => generateSecret()));
  assert.equal(values.size, 50);
});

test('generateDeploySecrets 生成四个不同名字的密钥', () => {
  const secrets = generateDeploySecrets();
  const keys = Object.keys(secrets);
  assert.deepEqual(keys.sort(), ['ADMIN_TOKEN', 'CONFIG_ENCRYPTION_KEY', 'EPAY_KEY', 'POLL_TRIGGER_TOKEN']);
  const values = Object.values(secrets);
  assert.equal(new Set(values).size, values.length);
});
