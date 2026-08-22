import { DeployError } from './errors.js';

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MISSING_SUBDOMAIN_RE = /do not have a workers\.dev subdomain|没有.*workers\.dev.*子域名/iu;

export async function getWorkersDevAccountSubdomain(client, accountId) {
  try {
    const accountInfo = await client.getJSON(`/accounts/${accountId}/workers/subdomain`, {
      stage: 'workers_dev_setup',
    });
    return String(accountInfo.result?.subdomain ?? '').trim().toLowerCase() || null;
  } catch (error) {
    if (error instanceof DeployError && MISSING_SUBDOMAIN_RE.test(`${error.message}\n${error.detail ?? ''}`)) return null;
    throw error;
  }
}

export async function createWorkersDevAccountSubdomain(client, accountId, subdomain) {
  const normalized = String(subdomain ?? '').trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(normalized)) {
    throw new DeployError(
      'workers_dev_setup',
      'workers.dev 子域名只能使用小写字母、数字和短横线，不能以短横线开头或结尾，最长 63 个字符',
      { retryable: false },
    );
  }
  const accountInfo = await client.putJSON(
    `/accounts/${accountId}/workers/subdomain`,
    { subdomain: normalized },
    { stage: 'workers_dev_setup' },
  );
  const created = String(accountInfo.result?.subdomain ?? '').trim().toLowerCase();
  if (!created) {
    throw new DeployError('workers_dev_setup', 'Cloudflare 没有返回新建的 workers.dev 子域名', { retryable: true });
  }
  return created;
}

export async function enableWorkersDevSubdomain(client, accountId, scriptName) {
  try {
    await client.postJSON(
      `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      { enabled: true },
      { stage: 'enable_subdomain' },
    );
    const accountInfo = await client.getJSON(`/accounts/${accountId}/workers/subdomain`, {
      stage: 'enable_subdomain',
    });
    const subdomain = accountInfo.result?.subdomain;
    if (!subdomain) {
      throw new DeployError(
        'enable_subdomain',
        '部署已经成功，但没能确认 workers.dev 子域名——去 Cloudflare 控制台 Workers & Pages 里手动检查一下 Domains & Routes。',
        { retryable: false },
      );
    }
    return `https://${scriptName}.${subdomain}.workers.dev`;
  } catch (err) {
    if (err instanceof DeployError && err.stage === 'enable_subdomain') throw err;
    throw new DeployError(
      'enable_subdomain',
      '部署已经成功，但没能确认 workers.dev 子域名——去 Cloudflare 控制台 Workers & Pages 里手动检查一下 Domains & Routes。',
      { retryable: false, detail: err instanceof DeployError ? err.detail : String(err) },
    );
  }
}
