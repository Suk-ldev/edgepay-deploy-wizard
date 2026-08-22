const state = {
  cfApiToken: '',
  cfAccountId: '',
  projectName: '',
  adminUsername: 'admin',
  publicBaseUrl: '',
  edgepayLicense: '',
  licenseInfo: null,
  mode: 'install',
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
    li.querySelector('.step-dot').textContent = isDone ? '✓' : String(step);
  });
}

function maskToken(token) {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`;
}

const initialQuery = new URLSearchParams(location.search);
if (initialQuery.get('project')) $('projectName').value = initialQuery.get('project');
if (initialQuery.get('publicBaseUrl')) $('publicBaseUrl').value = initialQuery.get('publicBaseUrl');

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
  const button = $('step2-next');
  button.disabled = true;
  button.textContent = '校验 License…';
  try {
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
    if (projectState.exists) {
      const choice = await confirmUpgrade(projectName, projectState.compatible);
      if (choice !== 'upgrade') {
        $('projectName').value = '';
        $('projectName').focus();
        errorEl.textContent = '请重新填写一个未被占用的项目名。';
        return;
      }
      state.mode = 'upgrade';
    }
  } catch (error) {
    errorEl.textContent = error.message;
    statusEl.textContent = 'License 校验未通过';
    statusEl.classList.add('bad');
    return;
  } finally {
    button.disabled = false;
    button.textContent = '下一步';
  }

  state.projectName = projectName;
  state.adminUsername = adminUsername;
  state.publicBaseUrl = normalizedPublicBaseUrl;
  state.edgepayLicense = edgepayLicense;
  state.licenseInfo = licenseInfo;

  $('summary-project').textContent = projectName;
  $('summary-mode').textContent = state.mode === 'upgrade' ? '无损升级（保留原配置）' : '新建部署';
  $('summary-admin').textContent = state.mode === 'upgrade' ? '保留原管理员设置' : adminUsername;
  $('summary-account').textContent = state.cfAccountId;
  $('summary-token').textContent = maskToken(state.cfApiToken);
  $('summary-license').textContent = `${licenseInfo.domain} · ${licenseInfo.entitlements.length} 个插件 · ${maskToken(edgepayLicense)}`;

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
    li.querySelector('span:last-child').textContent = `${STEP_LABELS[event.stage]} — ${event.message}`;
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
    return true;
  }
  $('projectName').value = '';
  showScreen(2);
  $('projectName').focus();
  $('step2-error').textContent = '请重新填写一个未被占用的项目名。';
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
        publicBaseUrl: state.publicBaseUrl || undefined,
        edgepayLicense: state.edgepayLicense || undefined,
        mode: state.mode,
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
                errorEl.textContent = '已切换为无损升级，请点击“开始升级”。';
              } else {
                $('projectName').value = '';
                showScreen(2);
                $('projectName').focus();
                $('step2-error').textContent = '请重新填写一个未被占用的项目名。';
              }
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
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
    <button type="button">复制</button>
  `;
  row.querySelector('button').addEventListener('click', () => {
    navigator.clipboard.writeText(value);
    row.querySelector('button').textContent = '已复制';
    setTimeout(() => { row.querySelector('button').textContent = '复制'; }, 1500);
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
      : '下面这些信息只会显示这一次，现在就复制保存。插件和支付通道需要登录后台配置。';
  list.appendChild(resultRow('访问地址', result.accessUrl));
  list.appendChild(resultRow('管理后台', result.adminUrl));
  if (result.domainBindingWarning) list.appendChild(resultRow('域名绑定提示', result.domainBindingWarning));
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
