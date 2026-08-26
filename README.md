<div align="center">

# EdgePay Deploy Wizard

EdgePay 官方无状态部署向导，在一次 HTTPS 会话中完成校验、创建、升级与域名绑定。

![Version](https://img.shields.io/badge/version-0.1.0-2563EB?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?style=flat-square&logo=javascript&logoColor=000)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![HTML5](https://img.shields.io/badge/HTML5-UI-E34F26?style=flat-square&logo=html5&logoColor=white)
![Storage](https://img.shields.io/badge/storage-none-64748B?style=flat-square)
[![License](https://img.shields.io/badge/license-MIT-16A34A?style=flat-square)](./LICENSE)

[![打开官方部署站](https://img.shields.io/badge/官方部署站-打开向导-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://deploy.imsuk.cn)
[![查看部署教程](https://img.shields.io/badge/Docs-图文教程-0F766E?style=for-the-badge&logo=readthedocs&logoColor=white)](https://deploy.imsuk.cn/guide.html)

</div>

> [!IMPORTANT]
> 用户部署与升级 EdgePay 的唯一入口是 [deploy.imsuk.cn](https://deploy.imsuk.cn)，所有操作
> 都从该站点发起，无需执行本地发布命令。

## 能做什么

向导通过流式响应展示每一步状态，并完成：

1. 校验 Cloudflare API Token 与 Account ID。
2. 校验 EdgePay License 的签名、状态、绑定域名和插件权益。
3. 从双源读取锁定版本的支付发行文件并逐个核对 SHA-256。
4. 识别同名项目；新项目进入创建流程，已有 EdgePay 可选择无损升级。
5. 新建时创建一个 D1 和所需随机 Secrets；升级时复用全部原配置。
6. 按 License 权益选择商业插件，未购买的插件代码不会被上传。
7. 绑定 License 对应的自定义域名，并保持 `workers.dev` 关闭。
8. 在完成页一次性返回需要由用户保存的密钥。

向导自身不使用 D1、KV 或其他持久化存储。Cloudflare Token 与 License 只存在于当前请求
内存，错误输出会经过脱敏处理。

## 使用前准备

- 一个已接入 Cloudflare 的正式域名。
- 域名所在账户的 Account ID。
- 专用于本次操作的 Cloudflare API Token。
- 在 [License 站](https://license.imsuk.cn)按同一正式域名生成的永久 License。

建议 Token 仅授予以下账户级权限：

- `Account / D1 / Edit`
- `Account / Workers Scripts / Edit`

不要使用 Global API Key。Token 仅用于访问 `api.cloudflare.com`，不会落盘、写入日志或
转发到其他域名。

## 部署与升级

打开 [官方部署站](https://deploy.imsuk.cn)并按页面提示填写信息。新建部署会自动：

- 创建或复用一个 D1；
- 写入完整 Worker 配置和 Secrets；
- 上传支付核心与当前权益包含的插件模块；
- 绑定公开域名；
- 按选择设置后台轮询任务。

升级时，向导只替换程序内容，原 D1、插件配置、支付通道、环境变量、Secrets、定时任务和
域名路由都保持不变。支付管理后台检测到新版本时也会跳转到同一升级流程。

## License 规则

1. 在 [license.imsuk.cn](https://license.imsuk.cn)填写支付服务的最终域名。
2. 免费插件默认包含；付费插件按需选择。
3. 保存以 `EPL1.` 开头的永久 License。
4. 部署或升级时填写同一域名和 License。

新建时，License 会保存为 `EDGEPAY_LICENSE` Secret；升级时只验证部署身份，不覆盖原值。
公开地址的 hostname 必须与 License 域名一致，且该域名必须位于填写的 Cloudflare 账户中。

## Secrets

| 名称 | 来源 | 用途 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 用户填写 | 管理后台密码，长度 8–128 字符 |
| `EPAY_KEY` | 自动生成 | ePay V1 通信密钥 |
| `POLL_TRIGGER_TOKEN` | 自动生成 | 外部轮询触发凭据 |
| `CONFIG_ENCRYPTION_KEY` | 自动生成 | D1 敏感配置加密 |
| `WATCHER_TRANSPORT_SECRET` | 用户填写或自动生成 | Payment 与 Watcher 的 HMAC 密钥 |
| `EDGEPAY_LICENSE` | 用户填写 | 永久 License |

完成页中的敏感值只展示一次。Docker Watcher 的 `TRANSPORT_KEY` 必须与
`WATCHER_TRANSPORT_SECRET` 完全相同。

## 技术结构

```text
deploy-wizard/
├── public/              # 向导页面、教程与样式
├── src/
│   ├── lib/             # Cloudflare、License、模板与流式响应模块
│   ├── deploy-handler.js
│   └── index.js         # Worker 入口
├── tests/               # Node.js 合同与回归测试
├── wrangler.toml        # 生产服务与固定发行版本配置
└── package.json
```

客户支付项目只创建一个 D1。收银台和管理后台资源已编译进支付模块，不创建额外 KV、
Workers Static Assets 绑定或资源命名空间。

## 本地检查

以下命令仅用于维护向导源码，不是用户部署 EdgePay 的入口：

```bash
npm ci
npm run check
npm test
npm run dev
```

## 发行完整性

`wrangler.toml` 使用 `TEMPLATE_COMMIT_SHA`、`TEMPLATE_VERSION` 和
`TEMPLATE_MANIFEST_SHA256` 锁定已验证的商业发行。向导优先从 jsDelivr 获取文件，
GitHub Raw 作为备用源；构建清单及其中每个模块都必须通过 SHA-256 校验。

商业发行仓只包含压缩后的核心、按插件拆分的发行模块、D1 结构和完整性清单，不包含完整
商业源码、Source Map 或 License Worker。

## License

本项目使用 [MIT License](./LICENSE)。
