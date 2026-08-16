import assert from 'node:assert/strict';
import test from 'node:test';
import { DeployError, redact } from '../src/lib/errors.js';

test('DeployError 序列化成干净的 JSON', () => {
  const err = new DeployError('d1_create', '数据库创建失败', { retryable: false, detail: 'name taken' });
  const json = err.toJSON();
  assert.deepEqual(json, {
    stage: 'd1_create',
    message: '数据库创建失败',
    retryable: false,
    detail: 'name taken',
  });
});

test('redact 从字符串里剥掉出现过的密钥', () => {
  const token = 'cf-token-abcdef1234567890';
  const message = `请求失败: Authorization: Bearer ${token}`;
  const result = redact(message, [token]);
  assert.ok(!result.includes(token));
  assert.ok(result.includes('[REDACTED]'));
});

test('redact 从错误对象和普通对象里剥掉密钥', () => {
  const token = 'super-secret-token-value';
  const err = new Error(`failed with token ${token}`);
  const redactedErr = redact(err, [token]);
  assert.ok(!redactedErr.message.includes(token));

  const obj = { detail: `token=${token}`, nested: { again: token } };
  const redactedObj = redact(obj, [token]);
  assert.ok(!JSON.stringify(redactedObj).includes(token));
});

test('redact 忽略太短的字符串，避免误伤正常文本', () => {
  const result = redact('hello world', ['ab']);
  assert.equal(result, 'hello world');
});

test('redact 对没有可用密钥时原样返回', () => {
  assert.equal(redact('untouched', []), 'untouched');
});
