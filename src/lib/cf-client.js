import { DeployError, redact } from './errors.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 极薄的 Cloudflare API 封装。每个方法只在单次请求内使用传入的 token，
 * 不做任何缓存、不写任何存储；调用方负责在这次请求处理结束后丢弃 token。
 */
export class CloudflareClient {
  constructor(apiToken) {
    this.apiToken = apiToken;
  }

  async #request(path, { method = 'GET', body, headers = {}, stage } = {}) {
    const url = `${CF_API_BASE}${path}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...headers,
      },
    };
    if (body !== undefined) init.body = body;

    let response;
    try {
      response = await fetch(url, init);
    } catch (networkError) {
      throw new DeployError(stage ?? 'cf_request', 'Cloudflare API 请求失败（网络层错误）', {
        retryable: true,
        detail: redact(String(networkError), [this.apiToken]),
      });
    }

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!response.ok || json.success === false) {
      const messages = Array.isArray(json.errors) ? json.errors.map((e) => e.message).join('; ') : undefined;
      throw new DeployError(stage ?? 'cf_request', messages || `Cloudflare API 返回错误状态 ${response.status}`, {
        retryable: response.status >= 500,
        detail: redact(JSON.stringify(json), [this.apiToken]),
        status: response.status,
      });
    }

    return json;
  }

  getJSON(path, opts) {
    return this.#request(path, opts);
  }

  postJSON(path, body, opts) {
    return this.#request(path, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  putJSON(path, body, opts) {
    return this.#request(path, {
      ...opts,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  putMultipart(path, formData, opts) {
    return this.#request(path, { ...opts, method: 'PUT', body: formData });
  }

  postMultipart(path, formData, opts) {
    return this.#request(path, { ...opts, method: 'POST', body: formData });
  }
}
