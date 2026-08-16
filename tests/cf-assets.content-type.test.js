import assert from 'node:assert/strict';
import test from 'node:test';
import { contentTypeForPath } from '../src/lib/cf-assets.js';

test('按扩展名给出正确的 Content-Type，而不是统一 text/plain', () => {
  assert.equal(contentTypeForPath('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeForPath('admin-login.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeForPath('styles.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeForPath('cashier/assets/cashier.js'), 'application/javascript; charset=utf-8');
  assert.equal(contentTypeForPath('fubei.jpg'), 'image/jpeg');
  assert.equal(contentTypeForPath('wechat.png'), 'image/png');
});

test('不认识的扩展名退回 application/octet-stream，不当成文本', () => {
  assert.equal(contentTypeForPath('data.bin'), 'application/octet-stream');
  assert.equal(contentTypeForPath('noext'), 'application/octet-stream');
});
