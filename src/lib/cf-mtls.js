import { DeployError } from './errors.js';

const CERT_BINDING = 'WECHAT_MTLS';
const MAX_PEM_BYTES = 64 * 1024;

function normalizePem(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function pemByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function validateWechatMtlsInput(certificate, privateKey) {
  const cert = normalizePem(certificate);
  const key = normalizePem(privateKey);
  if (!cert && !key) return { provided: false, certificate: '', privateKey: '' };
  if (!cert || !key) throw new Error('微信 mTLS 证书和私钥必须同时上传');
  if (pemByteLength(cert) > MAX_PEM_BYTES || pemByteLength(key) > MAX_PEM_BYTES) {
    throw new Error('微信 mTLS 证书或私钥文件过大（单个文件不能超过 64 KiB）');
  }
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/u.test(cert)) {
    throw new Error('微信证书不是有效的 PEM 证书，请选择 apiclient_cert.pem');
  }
  if (!/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC )?PRIVATE KEY-----$/u.test(key)) {
    throw new Error('微信私钥不是有效的 PEM 私钥，请选择 apiclient_key.pem');
  }
  return { provided: true, certificate: `${cert}\n`, privateKey: `${key}\n` };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function certificateName(projectName, certificate) {
  const project = String(projectName).replace(/[^a-z0-9-]/gu, '-').slice(0, 18) || 'worker';
  return `edgepay-wechat-${project}-${(await sha256Hex(certificate)).slice(0, 16)}`;
}

function certificateId(item) {
  return String(item?.id ?? item?.certificate_id ?? '');
}

function certificateExpiry(item) {
  return String(item?.expires_on ?? item?.expires_at ?? '');
}

async function findCertificate(client, accountId, name) {
  const response = await client.getJSON(
    `/accounts/${accountId}/mtls_certificates?ca=false&name=${encodeURIComponent(name)}`,
    { stage: 'wechat_mtls' },
  );
  return (Array.isArray(response?.result) ? response.result : []).find((item) => certificateId(item));
}

async function uploadCertificate(client, accountId, name, certificate, privateKey) {
  const response = await client.postJSON(`/accounts/${accountId}/mtls_certificates`, {
    ca: false,
    name,
    certificates: certificate,
    private_key: privateKey,
  }, { stage: 'wechat_mtls' });
  if (!certificateId(response?.result)) {
    throw new DeployError('wechat_mtls', 'Cloudflare 已接收微信证书，但没有返回证书 ID', {
      retryable: true,
    });
  }
  return response.result;
}

async function bindCertificate(client, accountId, scriptName, id) {
  const path = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`;
  const response = await client.getJSON(path, { stage: 'wechat_mtls' });
  const bindings = Array.isArray(response?.result?.bindings) ? response.result.bindings : [];
  const current = bindings.find((binding) => binding?.name === CERT_BINDING);
  if (current && certificateId(current) === id) return false;

  const inherited = bindings
    .filter((binding) => binding?.name && binding.name !== CERT_BINDING)
    .map((binding) => ({ type: 'inherit', name: String(binding.name) }));
  // 这个接口的 multipart part 必须叫 settings，内容再包一层 {"bindings": [...]}。
  // 用 "bindings" 作 part 名会被直接拒掉：
  //   10201 Missing settings part in multipart upload.
  // bindings 是整份替换的，已有绑定要靠 {type:'inherit'} 逐个带回来——
  // secret 只写不读，漏掉一个就永久没了。已实测 inherit 能保住 secret / 普通变量 / D1。
  const form = new FormData();
  form.append('settings', new Blob([JSON.stringify({
    bindings: [
      ...inherited,
      { type: 'mtls_certificate', name: CERT_BINDING, certificate_id: id },
    ],
  })], { type: 'application/json' }), 'settings.json');
  await client.patchMultipart(path, form, { stage: 'wechat_mtls' });
  return true;
}

/**
 * 上传（或按确定性名称复用）微信商户 API 证书，并把它绑定到目标 Worker。
 * 不删除旧证书：旧证书可能仍被其他 Worker 使用，换证回收由用户在 Cloudflare 控制台确认。
 */
export async function configureWechatMtls(client, accountId, scriptName, input) {
  const normalized = validateWechatMtlsInput(input?.certificate, input?.privateKey);
  if (!normalized.provided) return { configured: false, provided: false };
  const name = await certificateName(scriptName, normalized.certificate);
  try {
    let certificate = await findCertificate(client, accountId, name);
    const reused = Boolean(certificate);
    if (!certificate) {
      certificate = await uploadCertificate(
        client,
        accountId,
        name,
        normalized.certificate,
        normalized.privateKey,
      );
    }
    const id = certificateId(certificate);
    const bindingUpdated = await bindCertificate(client, accountId, scriptName, id);
    return {
      configured: true,
      provided: true,
      certificateId: id,
      expiresAt: certificateExpiry(certificate),
      reused,
      bindingUpdated,
    };
  } catch (error) {
    if (error instanceof DeployError && error.stage === 'wechat_mtls') throw error;
    throw new DeployError('wechat_mtls', `微信 mTLS 证书配置失败：${error.message ?? error}`, {
      retryable: error instanceof DeployError ? error.retryable : false,
      detail: error instanceof DeployError ? error.detail : String(error),
    });
  }
}
