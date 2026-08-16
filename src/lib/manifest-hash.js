function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function assetContentHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fullHash = new Uint8Array(digest);
  return bytesToHex(fullHash.slice(0, 16));
}

export async function buildAssetManifest(files) {
  const manifest = {};
  for (const file of files) {
    const path = file.path.startsWith('/') ? file.path : `/${file.path}`;
    const hash = await assetContentHash(file.bytes);
    manifest[path] = { hash, size: file.bytes.byteLength };
  }
  return manifest;
}
