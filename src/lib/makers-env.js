/**
 * Makers 环境变量的两条限制：单个值最多 1000 字节；值里带某些字符组合会被拒收
 * （"The value contains unsecurity string"，base64url 随机串偶尔就会命中）。
 *
 * 超长值拆成 NAME、NAME_2、NAME_3…，支付站平台层（payment-makers/src/makers-handler.js）
 * 按顺序拼回；PEM 的换行写成字面量 `\n`，平台层还原。密钥一律用十六进制生成。
 */

export const MAKERS_ENV_CHUNK = 900;

/** @returns 拆好的 { NAME: 第一段, NAME_2: 第二段, … } */
export function chunkedEnv(name, value) {
  const text = String(value ?? '');
  const result = {};
  for (let index = 0; index * MAKERS_ENV_CHUNK < text.length; index += 1) {
    result[index === 0 ? name : `${name}_${index + 1}`] = text.slice(index * MAKERS_ENV_CHUNK, (index + 1) * MAKERS_ENV_CHUNK);
  }
  return result;
}

/** 某个拆分变量的全部分段名（不含第一段本身）。 */
export function isChunkOf(name, key) {
  return new RegExp(`^${name}_\\d+$`, 'u').test(key);
}

export function pemForEnv(pem) {
  return String(pem ?? '').replace(/\r?\n/gu, '\\n');
}

export function hexSecret(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
