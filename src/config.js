export function readConfig(env) {
  return {
    templateOwner: env.TEMPLATE_OWNER || 'Suk-ldev',
    templateRepo: env.TEMPLATE_REPO || 'edgepay-serverless-payment',
    // 合并仓库使用 payment-worker；独立模板仓库保持为空。
    templateSubdir: env.TEMPLATE_SUBDIR || '',
    // 锁定的模板 commit SHA；升级模板版本时手动改这个值，不跟着 main 分支自动漂移。
    templateSha: env.TEMPLATE_COMMIT_SHA,
    templateEntrySha256: env.TEMPLATE_ENTRY_SHA256,
    templateSchemaSha256: env.TEMPLATE_SCHEMA_SHA256,
    githubToken: env.GITHUB_TOKEN,
  };
}
