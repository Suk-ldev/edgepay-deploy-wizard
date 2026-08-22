import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInput } from '../src/deploy-handler.js';

const valid = {
  cfApiToken: 'TOKEN',
  cfAccountId: '0123456789abcdef0123456789abcdef',
  projectName: 'edgepay',
  adminPassword: 'AdminPassword!2026',
  edgepayLicense: 'EPL1.cGF5bG9hZA.c2lnbmF0dXJl',
};

test('部署请求必须包含 License，免费插件授权也不例外', () => {
  assert.match(validateInput({ ...valid, edgepayLicense: '' }).edgepayLicense, /需要填写/u);
  assert.equal(validateInput(valid).edgepayLicense, undefined);
});

test('部署方式只接受新建或升级', () => {
  assert.equal(validateInput({ ...valid, mode: 'upgrade' }).mode, undefined);
  assert.equal(validateInput({ ...valid, mode: 'install' }).mode, undefined);
  assert.match(validateInput({ ...valid, mode: 'overwrite' }).mode, /install 或 upgrade/u);
});

test('新建部署必须填写管理员密码，Watcher 通信密钥可以留空', () => {
  assert.match(validateInput({ ...valid, adminPassword: '' }).adminPassword, /必须填写/u);
  assert.equal(validateInput(valid).watcherTransportSecret, undefined);
  assert.equal(validateInput({ ...valid, watcherTransportSecret: '' }).watcherTransportSecret, undefined);
  assert.match(validateInput({ ...valid, watcherTransportSecret: 'too-short' }).watcherTransportSecret, /24 至 128/u);
  assert.equal(validateInput({ ...valid, watcherTransportSecret: 'watcher-custom-secret-2026' }).watcherTransportSecret, undefined);
});

test('无损升级保留原密码与通信密钥，不要求重新填写', () => {
  const errors = validateInput({ ...valid, mode: 'upgrade', adminPassword: '', watcherTransportSecret: '' });
  assert.equal(errors.adminPassword, undefined);
  assert.equal(errors.watcherTransportSecret, undefined);
});
