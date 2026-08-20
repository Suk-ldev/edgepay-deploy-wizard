const state = {
  cfApiToken: '',
  cfAccountId: '',
  projectName: '',
  adminUsername: 'admin',
  publicBaseUrl: '',
  edgepayLicense: '',
  licenseInfo: null,
};

const STEP_LABELS = {
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
  if (edgepayLicense) {
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
    } catch (error) {
      errorEl.textContent = error.message;
      statusEl.textContent = 'License 校验未通过';
      statusEl.classList.add('bad');
      return;
    } finally {
      button.disabled = false;
      button.textContent = '下一步';
    }
  }

  state.projectName = projectName;
  state.adminUsername = adminUsername;
  state.publicBaseUrl = normalizedPublicBaseUrl;
  state.edgepayLicense = edgepayLicense;
  state.licenseInfo = licenseInfo;

  $('summary-project').textContent = projectName;
  $('summary-admin').textContent = adminUsername;
  $('summary-account').textContent = state.cfAccountId;
  $('summary-token').textContent = maskToken(state.cfApiToken);
  $('summary-license').textContent = edgepayLicense
    ? `${licenseInfo.domain} · ${licenseInfo.entitlements.length} 个插件 · ${maskToken(edgepayLicense)}`
    : '免费版（5 个免费插件）';

  showScreen(3);
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
  li.classList.remove('started', 'done', 'error');
  li.classList.add(event.status);
  if (event.detail) {
    li.querySelector('span:last-child').textContent = `${STEP_LABELS[event.stage]} — ${event.detail}`;
  }
  if (event.status === 'error') {
    li.querySelector('span:last-child').textContent = `${STEP_LABELS[event.stage]} — ${event.message}`;
  }
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
            errorEl.textContent = `${event.message || '部署失败'}${event.retryable ? '；可以直接重试。' : '；请返回修改配置后重试。'}`;
          }
        }
      }
    }
    if (!completed && !failed) errorEl.textContent = '部署连接提前结束，没有收到完成状态，请重试。';
  } catch {
    errorEl.textContent = '部署进度连接中断，请确认网络后重试；已完成的 D1 数据库会自动复用。';
  } finally {
    btn.disabled = false;
    btn.textContent = '开始部署';
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
  list.appendChild(resultRow('访问地址', result.workersDevUrl));
  list.appendChild(resultRow('管理后台', result.adminUrl));
  list.appendChild(resultRow('管理员用户名', result.adminUsername));
  list.appendChild(resultRow('管理员密码 (ADMIN_TOKEN)', result.ADMIN_TOKEN));
  list.appendChild(resultRow('EPAY_KEY', result.EPAY_KEY));
  list.appendChild(resultRow('POLL_TRIGGER_TOKEN', result.POLL_TRIGGER_TOKEN));
  list.appendChild(resultRow('CONFIG_ENCRYPTION_KEY', result.CONFIG_ENCRYPTION_KEY));
  list.appendChild(resultRow('WATCHER_TRANSPORT_SECRET（Docker TRANSPORT_KEY）', result.WATCHER_TRANSPORT_SECRET));
  $('open-admin').href = result.adminUrl;
}
