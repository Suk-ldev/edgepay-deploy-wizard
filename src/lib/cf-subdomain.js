import { DeployError } from './errors.js';

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
