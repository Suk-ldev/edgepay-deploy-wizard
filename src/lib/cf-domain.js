import { DeployError } from './errors.js';

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function normalizeHostname(hostname) {
  const normalized = String(hostname ?? '').trim().toLowerCase();
  if (!HOSTNAME_RE.test(normalized)) {
    throw new DeployError('bind_domain', '自定义域名格式不正确', { retryable: false });
  }
  return normalized;
}

export async function ensureWorkerCustomDomain(client, accountId, scriptName, hostname) {
  const normalized = normalizeHostname(hostname);
  const existingInfo = await client.getJSON(
    `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(normalized)}`,
    { stage: 'bind_domain' },
  );
  const existing = Array.isArray(existingInfo.result)
    ? existingInfo.result.find((item) => String(item.hostname ?? '').toLowerCase() === normalized)
    : null;

  if (existing) {
    if (existing.service !== scriptName) {
      throw new DeployError(
        'bind_domain',
        `域名 ${normalized} 已绑定到另一个 Worker（${existing.service}），请先在 Cloudflare 中解除原绑定`,
        { retryable: false },
      );
    }
    return { hostname: normalized, reused: true, id: existing.id ?? null };
  }

  const attached = await client.putJSON(
    `/accounts/${accountId}/workers/domains`,
    { hostname: normalized, service: scriptName },
    { stage: 'bind_domain' },
  );
  const result = attached.result ?? {};
  if (String(result.hostname ?? '').toLowerCase() !== normalized || result.service !== scriptName) {
    throw new DeployError('bind_domain', 'Cloudflare 没有确认自定义域名绑定结果', { retryable: true });
  }
  return { hostname: normalized, reused: false, id: result.id ?? null };
}
