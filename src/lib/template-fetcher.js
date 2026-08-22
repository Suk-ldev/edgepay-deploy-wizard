import { DeployError } from './errors.js';

const TEMPLATE_FILES = Object.freeze(['schema.sql', 'src/index.js']);
const SHA_RE = /^[a-f0-9]{40}$/iu;
const HASH_RE = /^[a-f0-9]{64}$/iu;

function encodePath(path) {
  return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function templatePath(path, subdir = '') {
  const root = String(subdir).replace(/^\/+|\/+$/gu, '');
  return root ? `${root}/${path}` : path;
}

function sourceCandidates({ owner, repo, sha, path, githubToken }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedSha = encodeURIComponent(sha);
  const encodedPath = encodePath(path);
  const githubHeaders = { 'user-agent': 'edgepay-deploy-wizard' };
  if (githubToken) githubHeaders.authorization = `Bearer ${githubToken}`;
  return [
    {
      name: 'jsDelivr',
      url: `https://cdn.jsdelivr.net/gh/${encodedOwner}/${encodedRepo}@${encodedSha}/${encodedPath}`,
      options: { redirect: 'follow' },
    },
    {
      name: 'GitHub Raw',
      url: `https://raw.githubusercontent.com/${encodedOwner}/${encodedRepo}/${encodedSha}/${encodedPath}`,
      options: { headers: githubHeaders, redirect: 'follow' },
    },
  ];
}

async function fetchPinnedFile(options) {
  const failures = [];
  for (const source of sourceCandidates(options)) {
    try {
      const response = await Reflect.apply(options.fetchImpl, globalThis, [source.url, source.options]);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 0) return bytes;
        failures.push(`${source.name} 返回空文件`);
      } else {
        failures.push(`${source.name} 返回 ${response.status}`);
      }
    } catch (error) {
      failures.push(`${source.name} 网络错误：${String(error)}`);
    }
  }
  const retryable = !failures.every((item) => item.includes('返回 404'));
  throw new DeployError(
    'template_fetch',
    `拉取模板文件 ${options.path} 失败（${failures.join('；')}）${retryable ? '，可以直接重试' : '，检查 TEMPLATE_COMMIT_SHA 是否正确'}`,
    { retryable },
  );
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function fetchTemplateFiles({
  owner,
  repo,
  sha,
  subdir = '',
  githubToken = '',
  expectedHashes = {},
  fetchImpl = fetch,
}) {
  if (!SHA_RE.test(String(sha ?? ''))) {
    throw new DeployError('template_fetch', 'TEMPLATE_COMMIT_SHA 必须是完整的 40 位 commit SHA', { retryable: false });
  }

  const files = [];
  for (const path of TEMPLATE_FILES) {
    const bytes = await fetchPinnedFile({
      owner,
      repo,
      sha,
      path: templatePath(path, subdir),
      githubToken,
      fetchImpl,
    });
    const expected = String(expectedHashes[path] ?? '').trim().toLowerCase();
    if (expected) {
      if (!HASH_RE.test(expected)) {
        throw new DeployError('template_fetch', `${path} 的预期 SHA-256 配置不合法`, { retryable: false });
      }
      const actual = await sha256Hex(bytes);
      if (actual !== expected) {
        throw new DeployError('template_fetch', `${path} 完整性校验失败，停止部署`, {
          retryable: false,
          detail: `expected=${expected}; actual=${actual}`,
        });
      }
    }
    files.push({ path, bytes });
  }
  return files;
}
