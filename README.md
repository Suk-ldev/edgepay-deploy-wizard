# EdgePay 一键部署向导

生产入口：<https://deploy.imsuk.cn>

向导通过一次无状态 HTTPS 请求完成：

1. 校验 Cloudflare API Token 与 Account ID；
2. 校验 EdgePay License 的签名、状态、绑定域名和插件权益；
3. 拉取锁定 commit 的支付 Worker 模板；
4. 创建或复用同名 D1 并执行 schema；
5. 生成 5 个随机 Worker Secret；
6. 把已内嵌前端资源的 Worker 脚本一次上传；
7. 开启用户账号的 `workers.dev` 地址；
8. 流式返回每一步状态与最终密钥。

向导本身不使用 D1、KV 或其他持久化存储。客户项目也只创建一个 D1；收银台与后台资源已编译进
Worker 模块，不创建 KV、Workers Static Assets 或额外资源命名空间。Cloudflare Token 和 License 只存在于当前请求
内存，错误输出会经过脱敏处理。

## License

1. 打开 <https://license.imsuk.cn>；
2. 输入支付 Worker 的正式域名；
3. 免费插件默认包含，其他插件按需选择，也可以全部不选；
4. 保存生成的永久 License；
5. 在向导中填写相同正式域名和 License。

向导要求每次部署都填写 License，并把它作为 `EDGEPAY_LICENSE` Worker Secret 上传。
“公开访问地址”的 hostname 必须与 License 域名一致；只使用免费插件时也要先在 License
站生成授权，只是不选择任何付费插件。

## 自动生成的 Secret

- `ADMIN_TOKEN`
- `EPAY_KEY`
- `POLL_TRIGGER_TOKEN`
- `CONFIG_ENCRYPTION_KEY`
- `WATCHER_TRANSPORT_SECRET`
- `EDGEPAY_LICENSE`

完成页只显示一次，请立即保存。Docker watcher 的 `TRANSPORT_KEY` 使用
`WATCHER_TRANSPORT_SECRET`，容器 `EDGEPAY_LICENSE` 使用同一 License。

## Docker 教程

完整图文步骤见线上页面：<https://deploy.imsuk.cn/guide.html>。

公开镜像：

```text
ghcr.io/suk-ldev/edgepay-watcher:latest
```

支持 `linux/amd64` 和 `linux/arm64`。

## Token 权限

建议创建专用 Cloudflare API Token，不使用 Global API Key。至少需要：

- Account / D1 / Edit
- Account / Workers Scripts / Edit

Token 仅用于调用 `api.cloudflare.com`，不落盘、不写日志、不转发到其他域名。

## 本地开发

```bash
npm ci
npm test
npm run check
npm run dev
```

## 部署向导自身

生产路由通过 `imsuk.eu.org` 的 Cloudflare for SaaS 区域接入：

```bash
npm run deploy
```

`workers.dev` 和 Preview URL 均关闭。

## 模板版本

`wrangler.toml` 的 `TEMPLATE_COMMIT_SHA` 必须锁定到已通过测试的
`Suk-ldev/edgepay-serverless-payment` commit，不跟随分支自动漂移。升级模板时先发布并测试
支付 Worker，再更新 commit SHA 和重新部署向导。
