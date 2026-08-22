export class DeployError extends Error {
  constructor(stage, message, { retryable = false, detail = undefined, status = undefined, action = undefined } = {}) {
    super(message);
    this.name = 'DeployError';
    this.stage = stage;
    this.retryable = retryable;
    this.detail = detail;
    this.status = status;
    this.action = action;
  }

  toJSON() {
    const result = {
      stage: this.stage,
      message: this.message,
      retryable: this.retryable,
      detail: this.detail,
    };
    if (this.status !== undefined) result.status = this.status;
    if (this.action !== undefined) result.action = this.action;
    return result;
  }
}

/**
 * 从任意值的字符串化表示里剥掉出现过的敏感字符串（比如用户提交的 Cloudflare Token）。
 * 用于错误对象在被 JSON 序列化、打日志之前的最后一道防线。
 */
export function redact(value, secrets) {
  const usableSecrets = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  if (usableSecrets.length === 0) return value;

  const redactString = (str) => {
    let out = str;
    for (const secret of usableSecrets) {
      out = out.split(secret).join('[REDACTED]');
    }
    return out;
  };

  if (typeof value === 'string') return redactString(value);

  if (value instanceof Error) {
    const clone = new Error(redactString(value.message));
    clone.name = value.name;
    if (value.stack) clone.stack = redactString(value.stack);
    return clone;
  }

  if (value && typeof value === 'object') {
    const json = JSON.stringify(value);
    return JSON.parse(redactString(json));
  }

  return value;
}
