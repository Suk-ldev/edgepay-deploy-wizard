import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInput } from '../src/deploy-handler.js';

const valid = {
  cfApiToken: 'TOKEN',
  cfAccountId: '0123456789abcdef0123456789abcdef',
  projectName: 'edgepay',
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
