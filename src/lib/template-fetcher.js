import { DeployError } from './errors.js';

const INCLUDED_PREFIXES = ['src/', 'public/'];
const INCLUDED_EXACT = ['schema.sql'];

export function isBinaryAsset(path) {
  return /\.(png|jpg|jpeg|gif|webp|ico)$/i.test(path);
}

/**
 * 纯函数：从 tar 包里解出来的路径列表中筛出这次部署真正需要的文件。
 * 只保留 src/**、public/** 和根目录的 schema.sql，忽略仓库里其他文件（README 等），
 * 这样模板仓库以后加别的文件不会被悄悄一起打包进部署产物。
 */
export function filterTemplatePaths(paths) {
  return paths.filter(
    (path) => INCLUDED_EXACT.includes(path) || INCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
}

function readCString(bytes, offset, length) {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function readOctal(bytes, offset, length) {
  const str = readCString(bytes, offset, length).trim();
  return str ? parseInt(str, 8) : 0;
}

/**
 * 极简 tar（POSIX ustar + GNU 长文件名扩展）解析：只处理普通文件条目，目录/pax 扩展头
 * 等一律跳过。GitHub 的 codeload tarball 用的正是这种格式，我们的文件路径都很短，
 * 不会触发长文件名之外的其他扩展头类型。
 */
export function parseTar(bytes) {
  const entries = [];
  let offset = 0;
  let longNameOverride = null;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const prefix = readCString(header, 345, 155);
    let name = readCString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;

    offset += 512;
    const data = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      longNameOverride = new TextDecoder().decode(data).replace(/\0+$/, '');
      continue;
    }
    if (longNameOverride) {
      name = longNameOverride;
      longNameOverride = null;
    }

    // '0' 和 '\0' 都表示普通文件；'5' 是目录，'x'/'g' 是 pax 扩展头，其余一律忽略。
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ name, bytes: data });
    }
  }

  return entries;
}

/**
 * 把 codeload 打包出来的路径（形如 "<repo>-<sha>/src/index.js"）去掉最外层那个目录名，
 * 变成相对仓库根目录的路径（"src/index.js"）。
 */
export function stripTopLevelDir(name) {
  const idx = name.indexOf('/');
  return idx === -1 ? '' : name.slice(idx + 1);
}

/**
 * 可选地把 monorepo 子目录映射成模板根目录。
 * 例如 payment-worker/src/index.js -> src/index.js。
 */
export function stripTemplateSubdir(path, subdir = '') {
  const normalized = String(subdir).replace(/^\/+|\/+$/gu, '');
  if (!normalized) return path;
  const prefix = `${normalized}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : '';
}

export async function fetchTemplateFiles({ owner, repo, sha, subdir = '', fetchImpl = fetch }) {
  // 一次性拉整个仓库在这个 commit 的 tarball，而不是每个文件单独发一次请求——
  // Workers 对单次请求里能发出的子请求数有硬性上限（免费版 50 个），模板有三十多个
  // 文件，逐个 fetch 很容易把配额花在这一步，导致后面建表/上传步骤莫名其妙地失败。
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { 'User-Agent': 'edgepay-deploy-wizard' } });
  } catch (networkError) {
    throw new DeployError('template_fetch', `拉取模板 tarball 失败：${String(networkError)}`, { retryable: true });
  }
  if (!response.ok) {
    throw new DeployError('template_fetch', `拉取模板 tarball 失败（GitHub 返回 ${response.status}），检查 TEMPLATE_COMMIT_SHA 是否正确`, {
      retryable: true,
    });
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
  const tarBytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  const rawEntries = parseTar(tarBytes);

  const files = [];
  for (const entry of rawEntries) {
    const repoPath = stripTopLevelDir(entry.name);
    const path = stripTemplateSubdir(repoPath, subdir);
    if (!path) continue;
    files.push({ path, bytes: entry.bytes, isBinary: isBinaryAsset(path) });
  }

  const filteredPaths = new Set(filterTemplatePaths(files.map((f) => f.path)));
  const result = files.filter((f) => filteredPaths.has(f.path));

  if (result.length === 0) {
    throw new DeployError('template_fetch', '模板 tarball 里没有找到 src/、public/ 或 schema.sql，检查 TEMPLATE_COMMIT_SHA 是否正确', {
      retryable: false,
    });
  }

  return result;
}
