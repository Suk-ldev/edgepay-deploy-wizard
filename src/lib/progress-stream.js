/**
 * 把一系列步骤的进度事件包成一个 NDJSON（每行一个 JSON 对象）的流式 Response。
 * 前端用 response.body 的 reader 按行读取，不需要 SSE，也不需要给无状态后端加一个可轮询的 job id。
 */
export function createProgressStream() {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const emit = (event) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
  const close = () => writer.close();

  return { readable, emit, close };
}

export const STEP_LABELS = {
  validate: '校验输入',
  verify_token: '校验 Cloudflare Token',
  license_verify: '校验 EdgePay License',
  template_fetch: '拉取模板源码',
  d1_create: '创建 D1 数据库',
  d1_schema: '建表',
  generate_secrets: '生成密钥',
  assets_upload: '上传静态资源',
  script_upload: '上传 Worker 脚本',
  enable_subdomain: '开启 workers.dev 子域名',
};

export const STEP_ORDER = Object.keys(STEP_LABELS);
