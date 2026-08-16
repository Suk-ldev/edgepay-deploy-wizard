export function readConfig(env) {
  return {
    templateOwner: env.TEMPLATE_OWNER || 'Suk-ldev',
    templateRepo: env.TEMPLATE_REPO || 'edgepay-serverless-payment',
    // 锁定的模板 commit SHA；升级模板版本时手动改这个值，不跟着 main 分支自动漂移。
    templateSha: env.TEMPLATE_COMMIT_SHA,
    githubToken: env.GITHUB_TOKEN,
  };
}
