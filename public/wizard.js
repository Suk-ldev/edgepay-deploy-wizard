const state = {
  cfApiToken: '',
  cfAccountId: '',
  projectName: '',
  adminUsername: 'admin',
  adminPassword: '',
  watcherTransportSecret: '',
  publicBaseUrl: '',
  edgepayLicense: '',
  licenseInfo: null,
  mode: 'install',
  enableCron: true,
  wechatMtlsCertificate: '',
  wechatMtlsPrivateKey: '',
  existingWechatMtlsConfigured: false,
};

const STEP_LABELS = {
  validate: '校验输入',
  verify_token: '校验 Cloudflare Token',
  license_verify: '校验 EdgePay License',
  project_check: '检查同名 Worker',
  template_fetch: '拉取模板源码',
  d1_create: '准备 D1 数据库',
  d1_schema: '建表',
  generate_secrets: '准备密钥与配置',
  script_upload: '上传 Worker 脚本',
  wechat_mtls: '配置微信退款证书',
  schedule_cron: '注册定时轮询',
  bind_domain: '绑定自定义域名',
};
const STEP_ORDER = Object.keys(STEP_LABELS);

function $(id) { return document.getElementById(id); }

function showScreen(n) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  $(`screen-${n}`).classList.add('active');
  document.querySelectorAll('#steps li').forEach((li) => {
    const step = Number(li.dataset.step);
    const isDone = step < n;
    li.classList.toggle('active', step === n);
    li.classList.toggle('done', isDone);
    if (step === n) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    li.querySelector('.step-dot').textContent = isDone ? '✓' : String(step);
  });
  $(`screen-${n}`).querySelector('h2').focus({ preventScroll: true });
  $('workspace').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

function maskToken(token) {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`;
}

const initialQuery = new URLSearchParams(location.search);
if (initialQuery.get('project')) $('projectName').value = initialQuery.get('project');
if (initialQuery.get('publicBaseUrl')) $('publicBaseUrl').value = initialQuery.get('publicBaseUrl');
if (initialQuery.get('setup') === 'wechat-mtls') $('wechat-mtls-setup').open = true;

/**
 * 按 Token 的证书权限决定要不要把微信证书上传摆出来。
 * Cloudflare 的证书探测有过误报，不能因为这里返回 denied 就把上传入口锁死；
 * 真正上传时仍会以 Cloudflare 的 wechat_mtls 步骤返回为准。
 */
function applyCertificatePermission(access, hint) {
  const setup = $('wechat-mtls-setup');
  const locked = $('wechat-mtls-locked');
  setup.hidden = false;
  const denied = access === 'denied';
  locked.hidden = !denied;
  locked.textContent = denied
    ? `${hint || '没有确认到账户级「SSL 和证书」编辑权限。'} 如果你已经给了权限，可以继续选择证书；最终以上传步骤的 Cloudflare 返回为准。`
    : '';
}

async function readWechatMtlsFiles() {
  if ($('wechat-mtls-setup').hidden) return { certificate: '', privateKey: '' };
  const certFile = $('wechatMtlsCertificate').files[0];
  const keyFile = $('wechatMtlsPrivateKey').files[0];
  if (!certFile && !keyFile) return { certificate: '', privateKey: '' };
  if (!certFile || !keyFile) throw new Error('微信 mTLS 证书和私钥必须同时选择');
  if (certFile.size > 64 * 1024 || keyFile.size > 64 * 1024) {
    throw new Error('微信 mTLS 证书或私钥文件过大（单个文件不能超过 64 KiB）');
  }
  const certificate = (await certFile.text()).replace(/\r\n?/g, '\n').trim();
  const privateKey = (await keyFile.text()).replace(/\r\n?/g, '\n').trim();
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(certificate)) {
    throw new Error('微信证书格式不对，请选择 apiclient_cert.pem');
  }
  if (!/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC )?PRIVATE KEY-----$/.test(privateKey)) {
    throw new Error('微信私钥格式不对，请选择 apiclient_key.pem');
  }
  return { certificate: `${certificate}\n`, privateKey: `${privateKey}\n` };
}

function confirmUpgrade(projectName, compatible) {
  const dialog = $('upgrade-dialog');
  const confirmButton = $('upgrade-confirm');
  $('upgrade-message').textContent = compatible
    ? `Cloudflare 账号中已经有名为 ${projectName} 的 EdgePay Worker。请确认它是不是你原来部署的版本。`
    : `Cloudflare 账号中已经有名为 ${projectName} 的 Worker，但没有识别到完整的 EdgePay 配置。为避免覆盖其他项目，请重新设置名称。`;
  confirmButton.hidden = !compatible;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (choice) => {
      dialog.close();
      resolve(choice);
    };
    confirmButton.onclick = () => finish('upgrade');
    $('upgrade-rename').onclick = () => finish('rename');
    dialog.oncancel = (event) => { event.preventDefault(); finish('rename'); };
  });
}

function returnToProjectName(message) {
  state.mode = 'install';
  $('projectName').value = '';
  showScreen(2);
  $('projectName').focus();
  $('step2-error').textContent = message || '请重新填写一个未被占用的项目名。';
}

// --- Step 1: Cloudflare credentials ---

$('step1-next').addEventListener('click', async () => {
  const token = $('cfApiToken').value.trim();
  const accountId = $('cfAccountId').value.trim();
  const errorEl = $('step1-error');
  errorEl.textContent = '';

  if (!token || !accountId) {
    errorEl.textContent = 'Token 和 Account ID 都要填';
    return;
  }

  const btn = $('step1-next');
  btn.disabled = true;
  btn.textContent = '验证中…';

  try {
    const res = await fetch('/api/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cfApiToken: token, cfAccountId: accountId }),
    });
    const json = await res.json();
    if (!json.ok) {
      errorEl.textContent = json.error || 'Token 校验失败';
      return;
    }
    state.cfApiToken = token;
    state.cfAccountId = accountId;
    applyCertificatePermission(json.certificates, json.certificatesHint);
    showScreen(2);
  } catch {
    errorEl.textContent = '网络错误，请重试';
  } finally {
    btn.disabled = false;
    btn.textContent = '验证并下一步';
  }
});

// --- Step 2: deployment info ---

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const current = Number(document.querySelector('.screen.active').id.replace('screen-', ''));
    showScreen(current - 1);
  });
});

$('step2-next').addEventListener('click', async () => {
  const projectName = $('projectName').value.trim();
  const adminUsername = $('adminUsername').value.trim() || 'admin';
  const adminPassword = $('adminPassword').value;
  const adminPasswordConfirm = $('adminPasswordConfirm').value;
  const watcherTransportSecret = $('watcherTransportSecret').value.trim();
  const enableCron = $('enableCron').checked;
  const publicBaseUrl = $('publicBaseUrl').value.trim();
  const edgepayLicense = $('edgepayLicense').value.trim();
  const errorEl = $('step2-error');
  const statusEl = $('license-status');
  errorEl.textContent = '';
  statusEl.textContent = '';
  statusEl.className = 'license-status';

  if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(projectName)) {
    errorEl.textContent = '项目名只能用小写字母、数字和短横线';
    return;
  }

  if (!edgepayLicense) {
    errorEl.textContent = '请先从 License 站生成并填写永久 License';
    return;
  }

  if (publicBaseUrl) {
    try {
      const url = new URL(publicBaseUrl);
      if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error();
    } catch {
      errorEl.textContent = '公开访问地址必须是无路径、无端口的 HTTPS 地址';
      return;
    }
  }

  let normalizedPublicBaseUrl = publicBaseUrl;
  let licenseInfo = null;
  let wechatMtlsFiles;
  const button = $('step2-next');
  button.disabled = true;
  button.textContent = '校验 License…';
  try {
    wechatMtlsFiles = await readWechatMtlsFiles();
    const response = await fetch('/api/verify-license', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license: edgepayLicense }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'License 校验失败');
    licenseInfo = result;
    if (!normalizedPublicBaseUrl) {
      normalizedPublicBaseUrl = `https://${result.domain}`;
      $('publicBaseUrl').value = normalizedPublicBaseUrl;
    }
    if (new URL(normalizedPublicBaseUrl).hostname !== result.domain) {
      throw new Error(`公开访问地址与 License 不一致；License 绑定 ${result.domain}`);
    }
    statusEl.textContent = `✓ 已验证：${result.domain} · ${result.entitlements.length} 个插件`;
    statusEl.classList.add('ok');

    button.textContent = '检查项目名…';
    const projectResponse = await fetch('/api/check-project', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cfApiToken: state.cfApiToken, cfAccountId: state.cfAccountId, projectName }),
    });
    const projectState = await projectResponse.json();
    if (!projectResponse.ok || !projectState.ok) throw new Error(projectState.error || '检查同名 Worker 失败');
    state.mode = 'install';
    state.existingWechatMtlsConfigured = false;
    if (projectState.exists) {
      const choice = await confirmUpgrade(projectName, projectState.compatible);
      if (choice !== 'upgrade') {
        $('projectName').value = '';
        $('projectName').focus();
        errorEl.textContent = '请重新填写一个未被占用的项目名。';
        return;
      }
      state.mode = 'upgrade';
      state.existingWechatMtlsConfigured = projectState.wechatMtlsConfigured === true;
    }
    if (state.mode === 'install') {
      if (adminPassword.length < 8 || adminPassword.length > 128) {
        throw new Error('管理员密码必须填写，长度为 8 至 128 个字符');
      }
      if (adminPassword !== adminPasswordConfirm) throw new Error('两次输入的管理员密码不一致');
      if (watcherTransportSecret && !/^[^\s]{24,128}$/.test(watcherTransportSecret)) {
        throw new Error('Watcher 通信密钥应为 24 至 128 个不含空白的字符，或留空自动生成');
      }
    }
  } catch (error) {
    errorEl.textContent = error.message;
    if (!licenseInfo) {
      statusEl.textContent = 'License 校验未通过';
      statusEl.classList.add('bad');
    }
    return;
  } finally {
    button.disabled = false;
    button.textContent = '下一步';
  }

  state.projectName = projectName;
  state.adminUsername = adminUsername;
  state.adminPassword = state.mode === 'install' ? adminPassword : '';
  state.watcherTransportSecret = state.mode === 'install' ? watcherTransportSecret : '';
  state.publicBaseUrl = normalizedPublicBaseUrl;
  state.edgepayLicense = edgepayLicense;
  state.licenseInfo = licenseInfo;
  state.enableCron = enableCron;
  state.wechatMtlsCertificate = wechatMtlsFiles.certificate;
  state.wechatMtlsPrivateKey = wechatMtlsFiles.privateKey;

  $('summary-project').textContent = projectName;
  $('summary-mode').textContent = state.mode === 'upgrade' ? '无损升级（保留原配置）' : '新建部署';
  $('summary-admin').textContent = state.mode === 'upgrade' ? '保留原管理员设置' : adminUsername;
  $('summary-admin-password').textContent = state.mode === 'upgrade' ? '保留原密码' : '已设置（确认页不显示）';
  $('summary-watcher-secret').textContent = state.mode === 'upgrade'
    ? '保留原通信密钥'
    : watcherTransportSecret ? '使用自定义密钥' : '自动生成';
  $('summary-cron').textContent = state.mode === 'upgrade'
    ? '保留原定时任务'
    : enableCron ? '每分钟自动轮询' : '不设（收银台触发 / 主动查询）';
  $('summary-account').textContent = state.cfAccountId;
  $('summary-token').textContent = maskToken(state.cfApiToken);
  $('summary-license').textContent = `${licenseInfo.domain} · ${licenseInfo.entitlements.length} 个插件 · ${maskToken(edgepayLicense)}`;
  $('summary-wechat-mtls').textContent = state.wechatMtlsCertificate
    ? (state.existingWechatMtlsConfigured ? '更换并重新绑定证书' : '上传并绑定证书')
    : state.existingWechatMtlsConfigured ? '保留现有证书绑定' : '未配置（微信 V2 API 退款不可用）';

  showScreen(3);
  $('deploy-btn').textContent = state.mode === 'upgrade' ? '开始升级' : '开始部署';
});

// --- Step 3: confirm & deploy ---

function renderProgressList() {
  const list = $('progress-list');
  list.innerHTML = '';
  for (const stage of STEP_ORDER) {
    const li = document.createElement('li');
    li.id = `progress-${stage}`;
    li.innerHTML = `<span class="dot"></span><span>${STEP_LABELS[stage]}</span>`;
    list.appendChild(li);
  }
}

function updateProgress(event) {
  const li = $(`progress-${event.stage}`);
  if (!li) return;
  li.classList.remove('started', 'done', 'warning', 'error');
  li.classList.add(event.status);
  if (event.detail) {
    li.querySelector('span:last-child').textContent = `${STEP_LABELS[event.stage]} — ${event.detail}`;
  }
  if (event.status === 'error') {
    li.querySelector('span:last-child').textContent = `${STEP_LABELS[event.stage]} — ${event.message}`;
  }
  if (event.status === 'warning') {
    // 警告可能带 message（异常路径）也可能带 detail（正常但需要提醒），两者都认。
    const text = event.message ?? event.detail ?? '';
    li.querySelector('span:last-child').textContent = text
      ? `${STEP_LABELS[event.stage]} — ${text}`
      : STEP_LABELS[event.stage];
  }
}

async function refreshDeploymentMode() {
  if (state.mode !== 'install') return true;
  const response = await fetch('/api/check-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cfApiToken: state.cfApiToken,
      cfAccountId: state.cfAccountId,
      projectName: state.projectName,
    }),
  });
  const projectState = await response.json();
  if (!response.ok || !projectState.ok) throw new Error(projectState.error || '重新检查同名 Worker 失败');
  if (!projectState.exists) return true;

  const choice = await confirmUpgrade(state.projectName, projectState.compatible);
  if (choice === 'upgrade') {
    state.mode = 'upgrade';
    $('summary-mode').textContent = '无损升级（保留原配置）';
    $('summary-admin').textContent = '保留原管理员设置';
    $('summary-admin-password').textContent = '保留原密码';
    $('summary-watcher-secret').textContent = '保留原通信密钥';
    state.existingWechatMtlsConfigured = projectState.wechatMtlsConfigured === true;
    $('summary-wechat-mtls').textContent = state.wechatMtlsCertificate
      ? (state.existingWechatMtlsConfigured ? '更换并重新绑定证书' : '上传并绑定证书')
      : state.existingWechatMtlsConfigured ? '保留现有证书绑定' : '未配置（微信 V2 API 退款不可用）';
    return true;
  }
  returnToProjectName();
  return false;
}

$('deploy-btn').addEventListener('click', async () => {
  const btn = $('deploy-btn');
  const errorEl = $('step3-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '正在部署…';
  $('step3-back').disabled = true;
  renderProgressList();

  try {
    btn.textContent = '重新检查项目…';
    if (!await refreshDeploymentMode()) return;
    btn.textContent = state.mode === 'upgrade' ? '正在升级…' : '正在部署…';
    const res = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cfApiToken: state.cfApiToken,
        cfAccountId: state.cfAccountId,
        projectName: state.projectName,
        adminUsername: state.adminUsername,
        adminPassword: state.mode === 'install' ? state.adminPassword : undefined,
        watcherTransportSecret: state.mode === 'install' ? state.watcherTransportSecret || undefined : undefined,
        publicBaseUrl: state.publicBaseUrl || undefined,
        edgepayLicense: state.edgepayLicense || undefined,
        mode: state.mode,
        enableCron: state.enableCron,
        wechatMtlsCertificate: state.wechatMtlsCertificate || undefined,
        wechatMtlsPrivateKey: state.wechatMtlsPrivateKey || undefined,
      }),
    });

    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => ({}));
      errorEl.textContent = json.error || `部署失败（${res.status}）`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let completed = false;
    let failed = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.stage === 'complete') {
          completed = true;
          renderResult(event.result);
          state.wechatMtlsCertificate = '';
          state.wechatMtlsPrivateKey = '';
          $('wechatMtlsCertificate').value = '';
          $('wechatMtlsPrivateKey').value = '';
          showScreen(4);
        } else {
          updateProgress(event);
          if (event.status === 'error') {
            failed = true;
            if (event.action === 'confirm_upgrade') {
              const choice = await confirmUpgrade(state.projectName, true);
              if (choice === 'upgrade') {
                state.mode = 'upgrade';
                $('summary-mode').textContent = '无损升级（保留原配置）';
                $('summary-admin').textContent = '保留原管理员设置';
                $('summary-admin-password').textContent = '保留原密码';
                $('summary-watcher-secret').textContent = '保留原通信密钥';
                errorEl.textContent = '已切换为无损升级，请点击“开始升级”。';
              } else {
                returnToProjectName();
              }
            } else if (event.action === 'rename_project') {
              returnToProjectName(event.message);
            } else {
              errorEl.textContent = `${event.message || '部署失败'}${event.retryable ? '；可以直接重试。' : '；请返回修改配置后重试。'}`;
            }
          }
        }
      }
    }
    if (!completed && !failed) errorEl.textContent = '部署连接提前结束，没有收到完成状态，请重试。';
  } catch {
    errorEl.textContent = '部署进度连接中断，请确认网络后重试；已完成的 D1 数据库会自动复用。';
  } finally {
    btn.disabled = false;
    btn.textContent = state.mode === 'upgrade' ? '开始升级' : '开始部署';
    $('step3-back').disabled = false;
  }
});

// --- Step 4: result ---

function resultRow(label, value) {
  const row = document.createElement('div');
  row.className = 'result-item';
  row.innerHTML = `
    <div>
      <div class="label"></div>
      <div class="value"></div>
    </div>
    <button type="button">复制</button>
  `;
  row.querySelector('.label').textContent = label;
  row.querySelector('.value').textContent = value;
  const button = row.querySelector('button');
  button.setAttribute('aria-label', `复制${label}`);
  button.setAttribute('aria-live', 'polite');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
    }
    setTimeout(() => { button.textContent = '复制'; }, 2000);
  });
  return row;
}

function renderResult(result) {
  const list = $('result-list');
  list.innerHTML = '';
  $('complete-title').textContent = result.mode === 'upgrade' ? '升级完成' : '部署完成';
  $('result-hint').textContent = result.domainBindingWarning
    ? `${result.note} ${result.mode === 'upgrade' ? '' : '下面的密钥仍然只显示这一次，请先保存。'}`
    : result.mode === 'upgrade'
      ? '程序已升级，原配置和数据保持不变。'
      : '请先复制保存以下凭据，关闭页面后不再展示。接下来进入管理后台，配置插件并创建收款通道。';
  list.appendChild(resultRow('访问地址', result.accessUrl));
  list.appendChild(resultRow('管理后台', result.adminUrl));
  if (result.domainBindingWarning) list.appendChild(resultRow('域名绑定提示', result.domainBindingWarning));
  if (result.wechatMtlsWarning) {
    list.appendChild(resultRow('微信退款证书提示', `${result.wechatMtlsWarning}；可修正 Token 权限或证书后再次无损升级`));
  } else if (result.wechatMtls?.configured) {
    const expiry = result.wechatMtls.expiresAt ? `，到期 ${result.wechatMtls.expiresAt}` : '';
    list.appendChild(resultRow('微信退款证书', `${result.wechatMtls.preserved ? '已保留' : '已绑定'}${expiry}`));
  } else {
    list.appendChild(resultRow('微信退款证书', '未配置；微信支付 V2 API 退款暂不可用'));
  }
  if (result.mode === 'upgrade') {
    list.appendChild(resultRow('保留内容', 'D1、插件配置、支付通道、环境变量、Secrets、定时任务和路由'));
  } else {
    list.appendChild(resultRow('管理员用户名', result.adminUsername));
    list.appendChild(resultRow('管理员密码 (ADMIN_TOKEN)', result.ADMIN_TOKEN));
    list.appendChild(resultRow('EPAY_KEY', result.EPAY_KEY));
    list.appendChild(resultRow('POLL_TRIGGER_TOKEN', result.POLL_TRIGGER_TOKEN));
    list.appendChild(resultRow('CONFIG_ENCRYPTION_KEY', result.CONFIG_ENCRYPTION_KEY));
    list.appendChild(resultRow('WATCHER_TRANSPORT_SECRET（Docker TRANSPORT_KEY）', result.WATCHER_TRANSPORT_SECRET));
  }
  $('open-admin').href = result.adminUrl;
}
