import { DeployError, redact } from './errors.js';

/**
 * EdgeOne Makers 的部署 API 封装（与官方 edgeone CLI 走同一个入口）。
 *
 * 所有调用都是 `POST <站点入口>` + `{ Action, ...参数 }` + Bearer Token。Token 只在本次
 * 请求内使用，不缓存、不落盘。部署包上传走 COS：先要一份临时凭据，签名后直接 PUT。
 */

export const MAKERS_ENDPOINTS = Object.freeze({
  china: 'https://pages-api.cloud.tencent.com/v1',
  global: 'https://pages-api.edgeone.ai/v1',
});

export const MAKERS_CONSOLES = Object.freeze({
  china: 'https://console.cloud.tencent.com/edgeone/pages',
  global: 'https://console.tencentcloud.com/edgeone/pages',
});

const encoder = new TextEncoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1Hex(key, text) {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text)));
}

async function sha1Hex(text) {
  return hex(await crypto.subtle.digest('SHA-1', encoder.encode(text)));
}

/** COS 要求的 URL 编码：在 encodeURIComponent 基础上再编码 !'()*。 */
function cosEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function cosPairs(record) {
  const pairs = Object.entries(record).map(([key, value]) => [cosEncode(key.toLowerCase()), cosEncode(value)]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    list: pairs.map(([key]) => key).join(';'),
    text: pairs.map(([key, value]) => `${key}=${value}`).join('&'),
  };
}

/** COS XML API 请求签名（q-sign-algorithm=sha1）。 */
export async function cosAuthorization({
  secretId, secretKey, method, pathname, headers = {}, params = {}, now = Date.now(), ttlSeconds = 900,
}) {
  const start = Math.floor(now / 1_000) - 60;
  const keyTime = `${start};${start + ttlSeconds}`;
  const signKey = await hmacSha1Hex(secretKey, keyTime);
  const signedParams = cosPairs(params);
  const signedHeaders = cosPairs(headers);
  const httpString = `${method.toLowerCase()}\n${pathname}\n${signedParams.text}\n${signedHeaders.text}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${signedHeaders.list}`,
    `q-url-param-list=${signedParams.list}`,
    `q-signature=${signature}`,
  ].join('&');
}

export class MakersClient {
  constructor(apiToken, site, { fetchImpl = fetch, sensitiveValues = [] } = {}) {
    if (!MAKERS_ENDPOINTS[site]) throw new TypeError(`未知的 Makers 站点：${site}`);
    this.apiToken = apiToken;
    this.site = site;
    // Workers 的全局 fetch 必须以 globalThis 为 this 调用，挂成实例方法直接调会报 Illegal invocation。
    this.fetch = (...args) => Reflect.apply(fetchImpl, globalThis, args);
    this.sensitiveValues = [apiToken, ...sensitiveValues].filter(Boolean).map(String);
  }

  get consoleUrl() {
    return MAKERS_CONSOLES[this.site];
  }

  async call(action, data = {}, { stage = 'makers_request' } = {}) {
    let response;
    try {
      response = await this.fetch(MAKERS_ENDPOINTS[this.site], {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiToken}` },
        body: JSON.stringify({ Action: action, ...data }),
      });
    } catch (networkError) {
      throw new DeployError(stage, 'EdgeOne Makers API 请求失败（网络层错误）', {
        retryable: true,
        detail: redact(String(networkError), this.sensitiveValues),
      });
    }
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
    const apiError = json?.Data?.Response?.Error;
    if (!response.ok || json.Code !== 0 || apiError) {
      const message = apiError?.Message || json.Message || `EdgeOne Makers API 返回错误状态 ${response.status}`;
      throw new DeployError(stage, message, {
        retryable: response.status >= 500,
        detail: redact(JSON.stringify({ action, code: apiError?.Code ?? json.Code, message }), this.sensitiveValues),
        status: response.status,
      });
    }
    return json.Data?.Response ?? {};
  }

  async findProject(name, { stage } = {}) {
    const response = await this.call('DescribePagesProjects', {
      Filters: [{ Name: 'Name', Values: [name] }], Offset: 0, Limit: 10,
    }, { stage });
    return (response.Projects ?? []).find((project) => project.Name === name) ?? null;
  }

  async createProject(name, area, { stage } = {}) {
    const response = await this.call('CreatePagesProject', {
      Name: name, Provider: 'Upload', Channel: 'Custom', Area: area, Source: 'cli',
    }, { stage });
    if (!response.ProjectId) throw new DeployError(stage, '创建 Makers 项目后没有拿到项目 ID', { retryable: true });
    return response.ProjectId;
  }

  async listEnvVars(projectId, { stage } = {}) {
    const response = await this.call('DescribePagesProjectEnvs', { ProjectId: projectId }, { stage });
    return response.EnvVars ?? [];
  }

  /** 写入生产环境变量：已有同名变量按 Id 更新，没有的新增。 */
  async setEnvVars(projectId, vars, { stage } = {}) {
    const existing = new Map((await this.listEnvVars(projectId, { stage }))
      .filter((item) => (item.Env ?? ['Production']).includes('Production'))
      .map((item) => [item.Key, item]));
    for (const [key, value] of Object.entries(vars)) {
      const current = existing.get(key);
      if (current && current.Value === String(value)) continue;
      await this.call('ModifyPagesProjectEnvs', {
        ProjectId: projectId,
        EnvVars: [{ ...(current ? { Id: current.Id } : {}), Key: key, Value: String(value), Env: ['Production'] }],
      }, { stage });
    }
  }

  /**
   * 默认域名的访问凭证。中国大陆访问 Makers 默认域名必须带它（3 小时有效）；
   * 以 `eo_token`、`eo_time` 两个 Cookie 或同名查询参数携带。
   */
  async previewToken(domain, { stage } = {}) {
    const response = await this.call('DescribePagesEncipherToken', { Text: domain }, { stage });
    if (!response.Token || !response.Timestamp) throw new DeployError(stage, 'Makers 没有返回默认域名的访问凭证', { retryable: true });
    return { token: String(response.Token), timestamp: String(response.Timestamp) };
  }

  async deleteEnvVars(projectId, items, { stage } = {}) {
    for (const item of items) {
      await this.call('DeletePagesProjectEnvs', {
        ProjectId: projectId,
        EnvVars: [{ Id: item.Id, Key: item.Key, Value: item.Value ?? '' }],
      }, { stage });
    }
  }

  /** 部署包（zip 字节）传到 Makers 指定的 COS 位置，返回创建部署要用的 TempBucketPath。 */
  async uploadPackage(projectId, zipBytes, fileName, { stage } = {}) {
    const token = await this.call('DescribePagesCosTempToken', { ProjectId: projectId }, { stage });
    const { Bucket: bucket, TargetPath: targetPath, Credentials: credentials } = token;
    if (!bucket || !targetPath || !credentials?.TmpSecretId) {
      throw new DeployError(stage, 'Makers 没有返回完整的上传凭据', { retryable: true });
    }
    const key = `${targetPath}/${fileName}`;
    const pathname = `/${key.split('/').map(cosEncode).join('/')}`;
    const host = `${bucket}.cos.accelerate.myqcloud.com`;
    const headers = { host, 'content-length': String(zipBytes.length) };
    const authorization = await cosAuthorization({
      secretId: credentials.TmpSecretId,
      secretKey: credentials.TmpSecretKey,
      method: 'PUT',
      pathname,
      headers,
    });
    let response;
    try {
      response = await this.fetch(`https://${host}${pathname}`, {
        method: 'PUT',
        headers: {
          authorization,
          'content-type': 'application/zip',
          'content-length': String(zipBytes.length),
          'x-cos-security-token': credentials.Token,
        },
        body: zipBytes,
      });
    } catch (networkError) {
      throw new DeployError(stage, '部署包上传到腾讯云 COS 失败（网络层错误）', {
        retryable: true, detail: String(networkError),
      });
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new DeployError(stage, `部署包上传到腾讯云 COS 失败（${response.status}）`, {
        retryable: response.status >= 500, detail: redact(text, [credentials.Token, credentials.TmpSecretKey]),
      });
    }
    return key;
  }

  async createDeployment(projectId, tempBucketPath, { stage } = {}) {
    const response = await this.call('CreatePagesDeployment', {
      ProjectId: projectId,
      ViaMeta: 'Upload',
      Provider: 'Upload',
      Env: 'Production',
      DistType: 'Zip',
      TempBucketPath: tempBucketPath,
      BuildFrom: 'CLI',
    }, { stage });
    if (!response.DeploymentId) throw new DeployError(stage, '创建部署后没有拿到部署 ID', { retryable: true });
    return response.DeploymentId;
  }

  async deploymentStatus(projectId, deploymentId, { stage } = {}) {
    const response = await this.call('DescribePagesDeployments', {
      ProjectId: projectId, Offset: 0, Limit: 20, OrderBy: 'CreatedOn', Order: 'Desc',
    }, { stage });
    return (response.Deployments ?? []).find((item) => item.DeploymentId === deploymentId) ?? null;
  }

  /** 构建失败时取日志末尾几行，给用户看得懂的原因，而不是只有一句 Failed。 */
  async deploymentLogTail(projectId, deploymentId, lines = 12) {
    try {
      const { LogUrl: logUrl } = await this.call('DescribePagesDeploymentLog', { ProjectId: projectId, DeploymentId: deploymentId });
      if (!logUrl) return '';
      const text = await (await this.fetch(logUrl)).text();
      const messages = [];
      for (const line of text.split('\n')) {
        try {
          for (const [, message] of JSON.parse(line).ls ?? []) {
            const clean = String(message).replace(/\u001b\[[0-9;]*m/gu, '').trim();
            if (clean) messages.push(clean);
          }
        } catch { /* 日志里夹着非 JSON 行，跳过 */ }
      }
      return redact(messages.slice(-lines).join('\n'), this.sensitiveValues);
    } catch {
      return '';
    }
  }
}
