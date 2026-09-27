/**
 * 最小的 ZIP 写入器（只做"存储"不压缩）。
 *
 * Makers 的部署包要先打成 zip 传到 COS。Worker 里没有 zip 库，部署包只有十来个文件、
 * 几 MB，不压缩也远在 COS 单次上传的上限之内；省掉 deflate 就只剩 CRC32 和几段固定头。
 */

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 固定一个 DOS 时间（2026-01-01 00:00），同样的输入总是打出同样的字节。 */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
/** 通用标志第 11 位：文件名是 UTF-8。 */
const UTF8_FLAG = 0x0800;

/** @param {{ path: string, content: string | Uint8Array }[]} files */
export function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const seen = new Set();

  for (const file of files) {
    const path = String(file.path).replace(/^\/+/u, '');
    if (!path || path.includes('..') || seen.has(path)) throw new Error(`部署包里的文件路径不合法：${file.path}`);
    seen.add(path);
    const name = encoder.encode(path);
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    // 高字节 3 = Unix：解包工具只有看到它才会采用下面外部属性里的权限位。
    entry.setUint16(4, (3 << 8) | 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, UTF8_FLAG, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, DOS_TIME, true);
    entry.setUint16(14, DOS_DATE, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true);
    entry.setUint16(32, 0, true);
    entry.setUint16(34, 0, true);
    entry.setUint16(36, 0, true);
    // 外部属性高 16 位是 Unix 权限：统一 0644，避免解包后读不了（Makers 构建踩过的坑）。
    entry.setUint32(38, (0o100644 << 16) >>> 0, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
