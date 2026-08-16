# EdgePay 一键部署向导

一个独立的 Cloudflare Worker，把 [EdgePay](https://github.com/Suk-ldev/edgepay-serverless-payment)
的部署过程（建 D1、建表、生成密钥、上传 Worker 脚本、开 workers.dev 子域名）包装成一个四步网页
向导：填 Cloudflare 凭据 → 填部署信息 → 确认并部署（带实时进度）→ 完成。

**这个向导只做基础设施自动化。** 支付插件/通道配置不在向导里，部署完成后需要登录 EdgePay 自己的
后台手动配置——这部分逻辑每个插件字段都不一样，而且要匹配后台现有的加密格式，故意没有塞进这个
向导里，保持它简单、无状态。

## Token 怎么处理的

- 你在向导页面填的 Cloudflare API Token，只会被 POST 到这个向导自己的 `/api/deploy`，全程 HTTPS。
- 全程只用作发往 `api.cloudflare.com` 的 `Authorization: Bearer <token>`，且都发生在同一次请求
  处理过程之内，用完即弃。
- **不落盘**：不写任何存储，不出现在日志里（`src/lib/errors.js` 有个 `redact()`，把请求里出现过的
  token 字符串从任何要序列化的错误对象里剥掉），不出现在响应体里，不转发给
  `api.cloudflare.com` 以外的任何域名。
- 向导本身**没有任何持久化绑定**——看 `wrangler.toml` 就知道，只有一个 `[assets]`，没有 D1、没有
  KV、没有 Secret Store。纯无状态请求/响应，即使向导自己的部署以后出问题，也没有数据库能被拖走。
- 建议用一个**权限收窄的 API Token**（不是 Global API Key），只勾 `Account.D1:Edit` 和
  `Account.Workers Scripts:Edit`，向导第一步里就有对应的建 Token 链接。

## 本地跑起来

```bash
npm install
npm test
npm run check
npm run dev
```

`npm run dev` 起了本地服务后，在浏览器里打开，把你自己的 Cloudflare Token 输进向导页面——全程只在
你自己的浏览器和本地 Worker 之间，不会经过任何第三方。

## 部署这个向导自己

```bash
npx wrangler login
npm run deploy
```

（可选）如果拉模板文件遇到 GitHub 限流（未认证是 60 次/小时），可以加一个零权限的 PAT：

```bash
npx wrangler secret put GITHUB_TOKEN
```

## 模板版本

`wrangler.toml` 里的 `TEMPLATE_COMMIT_SHA` 锁定了向导会去拉取的 EdgePay 模板版本，不跟着 `main`
分支自动漂移——避免模板仓库以后的改动在用户不知情的情况下改变每一次部署的行为。要升级模板版本，
手动把这个值改成新的 commit SHA 再重新部署这个向导。

## 已知需要用真实 Cloudflare 账号验证的地方

以下几点目前是照着 Cloudflare 文档实现的，还没有对着真实账号跑通过，正式使用前建议先自己测一遍：

- `src/lib/cf-worker-script.js` 里 D1 binding 的 `type` 字段（当前写的是 `"d1"`，文档里也有地方
  写 `"d1_database"`）。
- 除 `main_module` 外，其余模块文件在 multipart 上传里的 part 命名规则，是否必须和 `import` 语句
  里的相对路径字符串（去掉开头的 `./`）完全一致——如果不是，`src/*.js` 就不能原样上传，需要先跑一次
  esbuild 打包成单文件。
- `src/lib/cf-d1.js` 里读取新建数据库 ID 用的字段名（`result.uuid` / `result.id`）。
- `src/lib/cf-subdomain.js` 里开启/查询 workers.dev 子域名的接口路径。

`npm run dev` 起本地服务后，用你自己的 Cloudflare 账号走一遍完整流程就能验证这几点；如果哪一步报错，
对照 Cloudflare 返回的错误信息改对应的 `src/lib/cf-*.js` 就行——单元测试覆盖的是不需要联网的纯逻辑
（SQL 拆分、密钥生成、manifest 哈希、metadata 组装、模板文件过滤），这几个网络层的字段名没法在没有
真实账号的情况下自动化验证。
