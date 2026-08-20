const SECRET_BYTE_LENGTH = 32;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function generateSecret() {
  const bytes = new Uint8Array(SECRET_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function generateDeploySecrets() {
  return {
    ADMIN_TOKEN: generateSecret(),
    EPAY_KEY: generateSecret(),
    POLL_TRIGGER_TOKEN: generateSecret(),
    CONFIG_ENCRYPTION_KEY: generateSecret(),
    WATCHER_TRANSPORT_SECRET: generateSecret(),
  };
}
