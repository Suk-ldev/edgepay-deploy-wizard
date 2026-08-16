import { DeployError } from './errors.js';

const INCLUDED_PREFIXES = ['src/', 'public/'];
const INCLUDED_EXACT = ['schema.sql'];

/**
 * 纯函数：从 GitHub tree API 的响应里筛出这次部署真正需要的文件路径。
 * 只保留 src/**、public/** 和根目录的 schema.sql，忽略仓库里其他文件（README 等），
 * 这样模板仓库以后加别的文件不会被悄悄一起打包进部署产物。
 */
export function filterTemplateTree(treeResponse) {
  const entries = treeResponse?.tree ?? [];
  return entries
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path)
    .filter((path) => INCLUDED_EXACT.includes(path) || INCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

export function isBinaryAsset(path) {
  return /\.(png|jpg|jpeg|gif|webp|ico)$/i.test(path);
}

export async function fetchTemplateFiles({ owner, repo, sha, githubToken, fetchImpl = fetch }) {
  const headers = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};

  const treeRes = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    { headers: { ...headers, 'User-Agent': 'edgepay-deploy-wizard' } },
  );
  if (!treeRes.ok) {
    throw new DeployError('template_fetch', `拉取模板文件列表失败（GitHub 返回 ${treeRes.status}）`, {
      retryable: true,
    });
  }
  const tree = await treeRes.json();
  const paths = filterTemplateTree(tree);

  if (paths.length === 0) {
    throw new DeployError('template_fetch', '模板仓库里没有找到 src/、public/ 或 schema.sql，检查 TEMPLATE_COMMIT_SHA 是否正确', {
      retryable: false,
    });
  }

  const files = [];
  for (const path of paths) {
    const rawRes = await fetchImpl(
      `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`,
      { headers },
    );
    if (!rawRes.ok) {
      throw new DeployError('template_fetch', `拉取模板文件 ${path} 失败（GitHub 返回 ${rawRes.status}）`, {
        retryable: true,
      });
    }
    const bytes = new Uint8Array(await rawRes.arrayBuffer());
    files.push({ path, bytes, isBinary: isBinaryAsset(path) });
  }

  return files;
}
