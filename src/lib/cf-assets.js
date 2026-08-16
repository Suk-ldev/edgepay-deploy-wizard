import { DeployError } from './errors.js';
import { buildAssetManifest } from './manifest-hash.js';

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 静态资源两段式直传：
 *   1) 提交 manifest（路径 -> hash/size），拿到需要上传的 bucket 分组和一个上传用 jwt。
 *   2) 逐个 bucket 把文件内容 POST 上去；docs 对"哪次响应携带最终 completion jwt"描述不一致
 *      （可能是每次响应都带、也可能只有最后一次），所以每次都记录返回的 jwt，最终用最后一次
 *      拿到的值——这样无论是哪种语义都能拿到正确的结果。
 */
export async function uploadAssets(client, accountId, scriptName, files) {
  const manifest = await buildAssetManifest(files);
  const byHash = new Map();
  for (const file of files) {
    const path = file.path.startsWith('/') ? file.path : `/${file.path}`;
    byHash.set(manifest[path].hash, file);
  }

  let session;
  try {
    session = await client.postJSON(
      `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
      { manifest },
      { stage: 'assets_upload' },
    );
  } catch (err) {
    throw new DeployError('assets_upload', `静态资源上传会话创建失败：${err.message}`, {
      retryable: true,
      detail: err instanceof DeployError ? err.detail : String(err),
    });
  }

  const buckets = session.result?.buckets ?? [];
  let jwt = session.result?.jwt;

  if (!jwt) {
    throw new DeployError('assets_upload', '静态资源上传会话没有返回有效的上传令牌', { retryable: true });
  }

  if (buckets.length === 0) {
    // 所有文件内容都已经存在（按 hash 去重命中），返回的 jwt 本身就是最终 completion token。
    return jwt;
  }

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) {
        throw new DeployError('assets_upload', `服务端要求上传 hash ${hash}，但本地文件列表里找不到对应内容`, {
          retryable: false,
        });
      }
      const base64 = bytesToBase64(file.bytes);
      form.append(hash, new Blob([base64], { type: 'text/plain' }), hash);
    }

    let uploadResult;
    try {
      uploadResult = await client.postMultipart(
        `/accounts/${accountId}/workers/assets/upload?base64=true`,
        form,
        { stage: 'assets_upload', headers: { Authorization: `Bearer ${jwt}` } },
      );
    } catch (err) {
      throw new DeployError('assets_upload', `上传静态资源分片失败：${err.message}`, {
        retryable: true,
        detail: err instanceof DeployError ? err.detail : String(err),
      });
    }

    if (uploadResult.result?.jwt) jwt = uploadResult.result.jwt;
  }

  return jwt;
}
