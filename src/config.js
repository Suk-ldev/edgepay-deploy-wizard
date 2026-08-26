/**
 * 部署向导的配置。模板来源是**私有发行仓库**（只放混淆后的构建产物），
 * 不是公开源码仓库——公开仓库不含付费插件，也构建不出可部署的 Worker。
 */

export function readConfig(env) {
  return {
    templateOwner: env.TEMPLATE_OWNER || 'Suk-ldev',
    templateRepo: env.TEMPLATE_REPO || 'edgepay-payment-dist',
    // 发行仓库根目录就是产物目录，一般不需要子目录。
    templateSubdir: env.TEMPLATE_SUBDIR || '',
    // 锁定的发行 commit SHA；升级版本时手动改这个值，不跟着分支自动漂移。
    templateSha: env.TEMPLATE_COMMIT_SHA,
    templateVersion: env.TEMPLATE_VERSION,
    // 构建清单的 SHA-256。清单里再记录每个产物文件的哈希，
    // 于是"钉住一个哈希"就能锁住整次发行的全部内容。
    templateManifestSha256: env.TEMPLATE_MANIFEST_SHA256,
    // 私有仓库只读 Token。没有它就没法部署，这里不做匿名回退。
    githubToken: env.GITHUB_TOKEN,
  };
}
