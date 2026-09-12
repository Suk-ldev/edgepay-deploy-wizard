import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('部署站点包含图标、License 获取入口和 Docker 教程', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const guide = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');
  const icon = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  const tokenExample = await readFile(new URL('../public/cloudflare-token-example.png', import.meta.url));
  assert.match(index, /rel="icon" href="\/favicon\.svg"/u);
  // 缓存串不写死具体日期，否则每次改前端都要顺手改测试。真正要守的是
  // css 和 js 必须一起带同一个版本号——漏掉任何一个都会让用户拿到半新半旧的组合。
  const cssVersion = index.match(/wizard\.css\?v=([\w-]+)/u);
  const jsVersion = index.match(/wizard\.js\?v=([\w-]+)/u);
  assert.ok(cssVersion, 'index.html 必须给 wizard.css 带缓存串');
  assert.ok(jsVersion, 'index.html 必须给 wizard.js 带缓存串');
  assert.equal(cssVersion[1], jsVersion[1], 'wizard.css 与 wizard.js 的缓存串必须一起更新');
  assert.match(index, /cloudflare-token-example\.png/u);
  assert.match(index, /https:\/\/license\.imsuk\.cn/u);
  assert.match(index, /id="edgepayLicense"[^>]+required/u);
  assert.match(index, /id="adminPassword"/u);
  assert.match(index, /id="adminPasswordConfirm"/u);
  assert.match(index, /id="watcherTransportSecret"/u);
  assert.doesNotMatch(index, /免费版可留空|免费插件时可留空/u);
  assert.match(index, /\/guide\.html/u);
  assert.match(index, /id="upgrade-dialog"/u);
  assert.doesNotMatch(index, /workers-dev-dialog|workersDevSubdomain/u);
  assert.match(index, /这是原版本，开始升级/u);
  assert.match(index, /原 D1、插件配置、支付通道、环境变量、Secrets、定时任务和访问路由全部保留/u);
  assert.match(index, /id="summary-mode"/u);
  const wizard = await readFile(new URL('../public/wizard.js', import.meta.url), 'utf8');
  assert.match(wizard, /\/api\/check-project/u);
  assert.match(wizard, /async function refreshDeploymentMode/u);
  assert.match(wizard, /已切换为无损升级/u);
  assert.doesNotMatch(wizard, /\/api\/workers-subdomain|workersDevConfigured/u);
  assert.match(wizard, /bind_domain: '绑定自定义域名'/u);
  assert.match(wizard, /mode: state\.mode/u);
  assert.match(wizard, /result\.mode === 'upgrade'/u);
  assert.match(guide, /ghcr\.io\/suk-ldev\/edgepay-watcher:latest/u);
  assert.match(guide, /WATCHER_TRANSPORT_SECRET/u);
  assert.match(guide, /管理员密码为新建部署必填项/u);
  assert.match(guide, /留空时向导会生成高强度随机值/u);
  assert.match(guide, /无损升级/u);
  assert.match(guide, /License 域名直接绑定到支付 Worker/u);
  assert.match(guide, /不启用 <code>workers\.dev<\/code>/u);
  assert.match(guide, /原 D1、插件配置、支付通道、环境变量、Secrets、定时任务和访问路由都会保留/u);
  assert.match(guide, /cloudflare-token-example\.png/u);
  assert.match(icon, /<svg/u);
  assert.ok(tokenExample.length > 10_000);
});

test('教程提供安卓监听端下载，且安装包随站点发布', async () => {
  const guide = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');
  assert.match(guide, /href="\/edgepay-watcher-android\.apk"/u, '手机通知监听节必须给出 APK 下载链接');
  assert.match(guide, /通知使用权/u, '必须说明要授予通知使用权');
  const apk = await readFile(new URL('../public/edgepay-watcher-android.apk', import.meta.url));
  // APK 必须真随站点一起发布，否则下载链接 404。
  assert.ok(apk.length > 10_000, 'public 下必须存在安卓安装包');
});

test('Docker watcher 教程给出可直接粘贴的单条指令，要填的地方用中文标出来', async () => {
  const guide = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');
  const command = guide.match(/docker run -d --name payment-watcher[^<]*/u)?.[0];
  assert.ok(command, '必须有一条 docker run 单指令');
  // 一条能整段粘贴的指令：不靠反斜杠续行，Windows 终端里也能直接用。
  assert.ok(!command.includes('\\'), '指令里不该有续行反斜杠');
  assert.ok(!command.includes('\n'), '指令必须是单行');
  // 要用户填的四处必须是中文占位，不能是 example.com 这种看着像能用的假值。
  for (const placeholder of ['你的支付站地址', '你的Watcher传输密钥', '你的License', '你的存储目录']) {
    assert.ok(command.includes(`"${placeholder}"`), `指令里缺少占位 ${placeholder}`);
  }
  // 容器内路径是固定的，不该让用户改。
  assert.match(command, /-v "你的存储目录":\/app\/var\/storage/u);
  // 镜像源可以换（国内用加速源），但仓库和 tag 必须钉住。
  assert.match(command, /\S+\/suk-ldev\/edgepay-watcher:latest$/u);
  // 内存上限不写死：不同机器差别太大，限死了反而容易 OOM。
  assert.ok(!command.includes(' -m '), '不要写死内存上限');
  // shm-size 不是内存限制而是 Chromium 要的共享内存，默认命令里不带，
  // 但必须在正文里告诉用户浏览器型插件要加上，否则会莫名其妙崩。
  assert.ok(guide.includes('--shm-size 256m'), '缺少浏览器型插件的 shm-size 说明');
  // 每个占位都要有一句说明它是什么、去哪儿拿。
  for (const placeholder of ['你的支付站地址', '你的Watcher传输密钥', '你的License', '你的存储目录']) {
    assert.ok(guide.includes(`<code>${placeholder}</code> ——`), `${placeholder} 缺少说明`);
  }
});

test('浏览器版也给出完整可粘贴的指令，和直连版只差 tag 与 shm-size', async () => {
  const guide = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');
  const commands = [...guide.matchAll(/docker run -d --name payment-watcher[^<]*/gu)].map((m) => m[0]);
  assert.equal(commands.length, 2, '直连版和浏览器版各要有一条完整命令');

  const [direct, browser] = commands;
  assert.match(direct, /edgepay-watcher:latest$/u);
  assert.match(browser, /edgepay-watcher:latest-browser$/u);
  // 容器里没有显示器也就没有 /dev/shm 配额，Chromium 缺了这个会直接崩。
  assert.ok(browser.includes('--shm-size 256m'), '浏览器版必须带 shm-size');
  assert.ok(!direct.includes('--shm-size'), '直连版不需要 shm-size');

  // 两条命令除了这两点必须完全一致：用户照着改一个地方就行，不该有别的暗坑。
  const normalize = (text) => text.replace('--shm-size 256m ', '').replace(':latest-browser', ':latest');
  assert.equal(normalize(browser), normalize(direct));
});

test('教程目录与部署页跳转可用，所有代码可复制且使用一致的官方镜像源', async () => {
  const guide = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = new Set([...guide.matchAll(/id="([^"]+)"/gu)].map(match => match[1]));
  for (const link of guide.matchAll(/href="#([^"]+)"/gu)) assert.ok(ids.has(link[1]), `目录锚点不存在: ${link[1]}`);
  for (const link of index.matchAll(/href="\/guide\.html#([^"]+)"/gu)) assert.ok(ids.has(link[1]), `教程锚点不存在: ${link[1]}`);
  assert.match(guide, /id="guide-nav"/u);
  assert.match(guide, /先准备一个用于持久化的宿主机目录/u);
  assert.doesNotMatch(guide, /ghcr\.1ms\.run|mem_limit:|不需要建目录/u);
  assert.match(guide, /docker inspect payment-watcher --format '\{\{\.Config\.Image\}\}'/u);
  assert.ok(guide.indexOf('id="channels"') < guide.indexOf('id="watcher"'));
  const css = guide.match(/guide\.css\?v=([\w-]+)/u);
  const js = guide.match(/guide\.js\?v=([\w-]+)/u);
  assert.equal(css?.[1], js?.[1]);
  assert.ok(js);
});

test('工作台具备步骤语义、错误公告与减少动效设置', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/wizard.css', import.meta.url), 'utf8');
  const guideCss = await readFile(new URL('../public/guide.css', import.meta.url), 'utf8');
  assert.match(index, /aria-current="step"/u);
  for (const number of [1, 2, 3]) assert.match(index, new RegExp(`id="step${number}-error" role="alert"`, 'u'));
  assert.match(index, /id="workspace" tabindex="-1"/u);
  for (const source of [css, guideCss]) {
    assert.match(source, /prefers-reduced-motion/u);
    assert.match(source, /:focus-visible/u);
  }
});
