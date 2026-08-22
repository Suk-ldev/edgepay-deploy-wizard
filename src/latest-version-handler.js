const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA_RE = /^[a-f0-9]{40}$/iu;
const HASH_RE = /^[a-f0-9]{64}$/iu;

export function handleLatestVersion(env) {
  const version = String(env.TEMPLATE_VERSION ?? '');
  const commit = String(env.TEMPLATE_COMMIT_SHA ?? '');
  const sha256 = String(env.TEMPLATE_ENTRY_SHA256 ?? '');
  if (!VERSION_RE.test(version) || !SHA_RE.test(commit) || !HASH_RE.test(sha256)) {
    return Response.json({ ok: false, error: '发行版本配置不完整' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return Response.json({
    ok: true,
    name: 'edgepay-commercial-worker',
    edition: 'public-commercial-encrypted',
    version,
    commit,
    sha256,
  }, { headers: { 'cache-control': 'no-store' } });
}
