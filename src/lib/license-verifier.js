import { DeployError, redact } from './errors.js';

export const LICENSE_SERVER_URL = 'https://license.imsuk.cn';
const LICENSE_RE = /^EPL1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;

export function licenseFetcher(env) {
  const service = env?.LICENSE_SERVICE;
  return typeof service?.fetch === 'function' ? service.fetch.bind(service) : fetch;
}

function fromBase64url(value) {
  const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function decodeLicensePayload(license) {
  const token = String(license ?? '').trim();
  const match = token.match(LICENSE_RE);
  if (!match) throw new DeployError('license_verify', 'License 格式应为 EPL1.payload.signature', { retryable: false });
  let payload;
  try { payload = JSON.parse(fromBase64url(match[1])); } catch {
    throw new DeployError('license_verify', 'License 内容格式无效', { retryable: false });
  }
  const domain = String(payload?.domain ?? '').trim().toLowerCase();
  if (!domain) throw new DeployError('license_verify', 'License 没有绑定域名', { retryable: false });
  return { token, payload, domain };
}

export async function verifyLicense(license, fetchImpl = fetch) {
  const decoded = decodeLicensePayload(license);
  let response;
  try {
    response = await fetchImpl(`${LICENSE_SERVER_URL}/api/v1/licenses/identify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: decoded.domain, license: decoded.token }),
    });
  } catch (error) {
    throw new DeployError('license_verify', '连接 License 服务器失败，请稍后重试', {
      retryable: true, detail: redact(String(error), [decoded.token]),
    });
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new DeployError('license_verify', String(result.error ?? `License 服务器返回 ${response.status}`), {
      retryable: response.status >= 500,
    });
  }
  return {
    domain: decoded.domain,
    licenseId: String(result.license_id ?? decoded.payload.license_id ?? ''),
    entitlements: Array.isArray(result.entitlements) ? result.entitlements.map(String) : [],
  };
}

export function normalizePublicBaseUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(String(value).trim()); } catch {
    throw new DeployError('validate', '公开访问地址格式无效', { retryable: false });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new DeployError('validate', '公开访问地址必须是无路径、无端口的 HTTPS 地址', { retryable: false });
  }
  return url.origin;
}
