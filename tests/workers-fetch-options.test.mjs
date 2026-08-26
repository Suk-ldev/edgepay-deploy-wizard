import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Workers 运行时对 fetch 选项的接受范围比浏览器窄，不支持的值会在**请求发出前**
 * 直接抛异常——而这类问题 node --test 完全看不见。
 *
 * 真实事故：授权站用了 `redirect: 'error'`，Workers 抛
 * "Invalid redirect value, must be one of follow or manual"，
 * 于是域名在线证明一次都没成功过，付费插件在客户那里一直显示未购买。
 */

const FORBIDDEN = [
  // Workers 明确不实现，只能用 follow / manual
  { pattern: /redirect:\s*'error'/u, why: "Workers 不支持 redirect:'error'，请用 'manual' 再自己判断 3xx" },
  // 以下在 Workers 里被忽略，写了会给人"已经生效"的错觉
  { pattern: /referrerPolicy:/u, why: 'Workers 忽略 referrerPolicy' },
  { pattern: /mode:\s*'(?:cors|no-cors|same-origin)'/u, why: 'Workers 忽略 fetch 的 mode' },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function serverFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) serverFiles(full, found);
    // bundled-assets.js 里是打包进来的浏览器代码，那些选项在浏览器里合法。
    else if (/\.(?:js|mjs)$/u.test(entry) && entry !== 'bundled-assets.js') found.push(full);
  }
  return found;
}

test('服务端代码不使用 Workers 不支持或会被忽略的 fetch 选项', () => {
  const offenders = [];
  for (const file of serverFiles(path.join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const code = source.split(String.fromCharCode(10))
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join(String.fromCharCode(10));
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(code)) offenders.push(`${path.relative(root, file)}：${why}`);
    }
  }
  assert.deepEqual(offenders, []);
});
