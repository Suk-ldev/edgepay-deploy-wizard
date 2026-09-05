const decoder = new TextDecoder();

export const DEPLOY_JSON_MAX_BYTES = 128 * 1024;

function bodyTooLarge(label, maxBytes) {
  return Object.assign(new Error(`${label}超过 ${maxBytes} 字节限制`), { status: 413 });
}

export async function readBoundedText(request, maxBytes, label = '请求体') {
  const maximum = Math.max(1, Number(maxBytes) || 1);
  const lengthHeader = String(request.headers.get('content-length') ?? '').trim();
  if (lengthHeader) {
    const contentLength = Number(lengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maximum) throw bodyTooLarge(label, maximum);
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw bodyTooLarge(label, maximum);
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}

export async function readBoundedJson(request, maxBytes = DEPLOY_JSON_MAX_BYTES, label = '请求体') {
  const raw = await readBoundedText(request, maxBytes, label);
  try { return raw ? JSON.parse(raw) : {}; } catch (error) {
    if (error?.status) throw error;
    throw new Error(`${label}不是合法 JSON`);
  }
}
