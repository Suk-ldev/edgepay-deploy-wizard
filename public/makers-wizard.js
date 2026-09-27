// EdgeOne Makers 部署流程（屏幕 m1～m4）。$、showScreen、maskToken、resultRow、readPemPair 来自 wizard.js。
(() => {
  const mk = {
    token: '',
    site: 'china',
    projectName: '',
    area: 'global',
    databaseUrl: '',
    adminUsername: 'admin',
    adminPassword: '',
    watcherTransportSecret: '',
    publicBaseUrl: '',
    edgepayLicense: '',
    licenseInfo: null,
    mode: 'install',
    wechatMtlsCertificate: '',
    wechatMtlsPrivateKey: '',
    existingWechatMtlsConfigured: false,
  };

  const STEP_LABELS = {
    validate: '校验输入',
    verify_token: '校验 Makers API Token',
    license_verify: '校验 EdgePay License',
    project_check: '检查同名项目',
    template_fetch: '拉取发行版本',
    package: '组装部署包',
    project_create: '创建 Makers 项目',
    env_config: '写入环境变量与密钥',
    upload: '上传部署包',
    deploy: '等待 Makers 构建',
    health_check: '检查支付站与数据库',
  };
  const SECRET_LABELS = {
    ADMIN_TOKEN: '管理员密码 (ADMIN_TOKEN)',
    EPAY_KEY: 'EPAY_KEY',
    POLL_TRIGGER_TOKEN: 'POLL_TRIGGER_TOKEN',
    CONFIG_ENCRYPTION_KEY: 'CONFIG_ENCRYPTION_KEY',
    WATCHER_TRANSPORT_SECRET: 'WATCHER_TRANSPORT_SECRET（Docker TRANSPORT_KEY）',
  };

  const query = new URLSearchParams(location.search);
  if (query.get('platform') === 'makers') {
    if (query.get('project')) $('mkProjectName').value = query.get('project');
    if (query.get('publicBaseUrl')) $('mkPublicBaseUrl').value = query.get('publicBaseUrl');
  }

  const selected = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const postJson = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { response, json: await response.json().catch(() => ({})) };
  };
  const pollCommand = (url) => `docker run -d --name edgepay-tick --restart unless-stopped alpine sh -c 'while true; do wget -q -T 30 -O /dev/null "${url}"; sleep 10; done'`;

  function confirmMakersUpgrade(projectName, compatible) {
    const dialog = $('upgrade-dialog');
    const confirmButton = $('upgrade-confirm');
    $('upgrade-title').textContent = '发现同名 Makers 项目';
    $('upgrade-preserve-note').textContent = '选择升级时只替换程序文件并更新 License，原数据库、插件配置、支付通道、密钥、定时轮询地址和绑定的域名全部保留。';
    $('upgrade-message').textContent = compatible
      ? `Makers 账号中已经有名为 ${projectName} 的 EdgePay 项目。请确认它是不是你原来部署的版本。`
      : `Makers 账号中已经有名为 ${projectName} 的项目，但没有识别到 EdgePay 配置。为避免覆盖其他项目，请重新设置名称。`;
    confirmButton.hidden = !compatible;
    dialog.showModal();
    return new Promise((resolve) => {
      const finish = (choice) => { dialog.close(); resolve(choice); };
      confirmButton.onclick = () => finish('upgrade');
      $('upgrade-rename').onclick = () => finish('rename');
      dialog.oncancel = (event) => { event.preventDefault(); finish('rename'); };
    });
  }

  function applyMode(mode) {
    mk.mode = mode;
    $('mk-summary-mode').textContent = mode === 'upgrade' ? '无损升级（保留原配置和数据）' : '新建部署';
    $('mk-summary-area').textContent = mode === 'upgrade'
      ? '沿用原项目'
      : mk.area === 'overseas' ? '中国大陆以外（免备案）' : '全球（含中国大陆，域名需备案）';
    $('mk-summary-database').textContent = mk.databaseUrl ? maskToken(mk.databaseUrl) : '沿用原连接串';
    $('mk-summary-admin').textContent = mode === 'upgrade' ? '保留原管理员设置' : `${mk.adminUsername}（密码已设置）`;
    $('mk-summary-watcher-secret').textContent = mode === 'upgrade'
      ? '保留原通信密钥'
      : mk.watcherTransportSecret ? '使用自定义密钥' : '自动生成';
    $('mk-summary-wechat-mtls').textContent = mk.wechatMtlsCertificate
      ? (mk.existingWechatMtlsConfigured ? '更换证书' : '写入证书')
      : mk.existingWechatMtlsConfigured ? '保留现有证书' : '未配置（微信 V2 API 退款不可用）';
    $('mk-deploy-btn').textContent = mode === 'upgrade' ? '开始升级' : '开始部署';
  }

  function backToProjectName(message) {
    mk.mode = 'install';
    $('mkProjectName').value = '';
    showScreen('m2');
    $('mkProjectName').focus();
    $('m2-error').textContent = message || '请重新填写一个未被占用的项目名。';
  }

  // --- m1: Makers Token ---
  $('m1-next').addEventListener('click', async () => {
    const token = $('makersToken').value.trim();
    const site = selected('makersSite') || 'china';
    const errorEl = $('m1-error');
    errorEl.textContent = '';
    if (!token) { errorEl.textContent = '请填写 Makers API Token'; return; }
    const button = $('m1-next');
    button.disabled = true;
    button.textContent = '验证中…';
    try {
      const { json } = await postJson('/api/makers/verify-token', { makersToken: token, site });
      if (!json.ok) { errorEl.textContent = json.error || 'Token 校验失败'; return; }
      mk.token = token;
      mk.site = site;
      showScreen('m2');
    } catch {
      errorEl.textContent = '网络错误，请重试';
    } finally {
      button.disabled = false;
      button.textContent = '验证并下一步';
    }
  });

  // --- m2: 部署信息 ---
  $('m2-next').addEventListener('click', async () => {
    const projectName = $('mkProjectName').value.trim();
    const databaseUrl = $('mkDatabaseUrl').value.trim();
    const adminUsername = $('mkAdminUsername').value.trim() || 'admin';
    const adminPassword = $('mkAdminPassword').value;
    const adminPasswordConfirm = $('mkAdminPasswordConfirm').value;
    const watcherTransportSecret = $('mkWatcherTransportSecret').value.trim();
    const publicBaseUrl = $('mkPublicBaseUrl').value.trim();
    const edgepayLicense = $('mkEdgepayLicense').value.trim();
    const errorEl = $('m2-error');
    const statusEl = $('mk-license-status');
    errorEl.textContent = '';
    statusEl.textContent = '';
    statusEl.className = 'license-status';

    if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(projectName)) { errorEl.textContent = '项目名只能用小写字母、数字和短横线'; return; }
    if (databaseUrl && !/^postgres(?:ql)?:\/\/\S+$/.test(databaseUrl)) { errorEl.textContent = '数据库连接串应为 postgres://用户:密码@主机:端口/库名'; return; }
    if (!edgepayLicense) { errorEl.textContent = '请先从 License 站生成并填写永久 License'; return; }
    if (publicBaseUrl) {
      try {
        const url = new URL(publicBaseUrl);
        if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error();
      } catch {
        errorEl.textContent = '公开访问地址必须是无路径、无端口的 HTTPS 地址';
        return;
      }
    }

    const button = $('m2-next');
    button.disabled = true;
    button.textContent = '校验 License…';
    let licenseInfo = null;
    let normalizedPublicBaseUrl = publicBaseUrl;
    try {
      const pem = await readPemPair($('mkWechatMtlsCertificate'), $('mkWechatMtlsPrivateKey'));
      const { response, json } = await postJson('/api/verify-license', { license: edgepayLicense });
      if (!response.ok || !json.ok) throw new Error(json.error || 'License 校验失败');
      licenseInfo = json;
      if (!normalizedPublicBaseUrl) {
        normalizedPublicBaseUrl = `https://${json.domain}`;
        $('mkPublicBaseUrl').value = normalizedPublicBaseUrl;
      }
      if (new URL(normalizedPublicBaseUrl).hostname !== json.domain) {
        throw new Error(`公开访问地址与 License 不一致；License 绑定 ${json.domain}`);
      }
      statusEl.textContent = `✓ 已验证：${json.domain} · ${json.entitlements.length} 个插件`;
      statusEl.classList.add('ok');

      button.textContent = '检查项目名…';
      const project = await postJson('/api/makers/check-project', { makersToken: mk.token, site: mk.site, projectName });
      if (!project.response.ok || !project.json.ok) throw new Error(project.json.error || '检查同名项目失败');
      let mode = 'install';
      mk.existingWechatMtlsConfigured = false;
      if (project.json.exists) {
        const choice = await confirmMakersUpgrade(projectName, project.json.compatible);
        if (choice !== 'upgrade') {
          $('mkProjectName').value = '';
          $('mkProjectName').focus();
          errorEl.textContent = '请重新填写一个未被占用的项目名。';
          return;
        }
        mode = 'upgrade';
        mk.existingWechatMtlsConfigured = project.json.wechatMtlsConfigured === true;
      }
      if (mode === 'install') {
        if (!databaseUrl) throw new Error('新建部署必须填写 PostgreSQL 连接串');
        if (adminPassword.length < 8 || adminPassword.length > 128) throw new Error('管理员密码必须填写，长度为 8 至 128 个字符');
        if (adminPassword !== adminPasswordConfirm) throw new Error('两次输入的管理员密码不一致');
        if (watcherTransportSecret && !/^[^\s]{24,128}$/.test(watcherTransportSecret)) {
          throw new Error('Watcher 通信密钥应为 24 至 128 个不含空白的字符，或留空自动生成');
        }
      }
      Object.assign(mk, {
        mode,
        projectName,
        area: selected('mkArea') || 'global',
        databaseUrl,
        adminUsername,
        adminPassword: mode === 'install' ? adminPassword : '',
        watcherTransportSecret: mode === 'install' ? watcherTransportSecret : '',
        publicBaseUrl: normalizedPublicBaseUrl,
        edgepayLicense,
        licenseInfo,
        wechatMtlsCertificate: pem.certificate,
        wechatMtlsPrivateKey: pem.privateKey,
      });
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

    $('mk-summary-project').textContent = mk.projectName;
    $('mk-summary-site').textContent = mk.site === 'china' ? '中国站' : '国际站';
    $('mk-summary-token').textContent = maskToken(mk.token);
    $('mk-summary-license').textContent = `${licenseInfo.domain} · ${licenseInfo.entitlements.length} 个插件 · ${maskToken(mk.edgepayLicense)}`;
    applyMode(mk.mode);
    showScreen('m3');
  });

  // --- m3: 部署 ---
  function renderProgress() {
    const list = $('mk-progress-list');
    list.innerHTML = '';
    for (const [stage, label] of Object.entries(STEP_LABELS)) {
      const li = document.createElement('li');
      li.id = `mk-progress-${stage}`;
      li.innerHTML = '<span class="dot"></span><span></span>';
      li.querySelector('span:last-child').textContent = label;
      list.appendChild(li);
    }
  }

  function updateProgress(event) {
    const li = $(`mk-progress-${event.stage}`);
    if (!li) return;
    li.classList.remove('started', 'done', 'warning', 'error');
    li.classList.add(event.status);
    const text = event.status === 'error' || event.status === 'warning' ? event.message ?? event.detail : event.detail;
    li.querySelector('span:last-child').textContent = text ? `${STEP_LABELS[event.stage]} — ${text}` : STEP_LABELS[event.stage];
  }

  function showEarlySecrets(secrets) {
    const box = $('mk-early-secrets');
    box.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'hint warn';
    note.textContent = '部署没有完成，但下面的密钥已经写进 Makers 项目。请先复制保存：重试时会走“无损升级”，不会再显示它们。';
    box.appendChild(note);
    for (const [key, label] of Object.entries(SECRET_LABELS)) {
      if (secrets[key]) box.appendChild(resultRow(label, secrets[key]));
    }
    box.hidden = false;
  }

  $('mk-deploy-btn').addEventListener('click', async () => {
    const button = $('mk-deploy-btn');
    const errorEl = $('m3-error');
    errorEl.textContent = '';
    $('mk-early-secrets').hidden = true;
    button.disabled = true;
    $('m3-back').disabled = true;
    button.textContent = mk.mode === 'upgrade' ? '正在升级…' : '正在部署…';
    renderProgress();
    let earlySecrets = null;
    try {
      const response = await fetch('/api/makers/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          makersToken: mk.token,
          site: mk.site,
          projectName: mk.projectName,
          mode: mk.mode,
          area: mk.mode === 'install' ? mk.area : undefined,
          databaseUrl: mk.databaseUrl || undefined,
          adminUsername: mk.adminUsername,
          adminPassword: mk.mode === 'install' ? mk.adminPassword : undefined,
          watcherTransportSecret: mk.mode === 'install' ? mk.watcherTransportSecret || undefined : undefined,
          publicBaseUrl: mk.publicBaseUrl || undefined,
          edgepayLicense: mk.edgepayLicense,
          wechatMtlsCertificate: mk.wechatMtlsCertificate || undefined,
          wechatMtlsPrivateKey: mk.wechatMtlsPrivateKey || undefined,
        }),
      });
      if (!response.ok || !response.body) {
        const json = await response.json().catch(() => ({}));
        errorEl.textContent = json.error ? `${json.error}${json.fields ? `：${Object.values(json.fields).join('；')}` : ''}` : `部署失败（${response.status}）`;
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      let failed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.secrets) earlySecrets = event.secrets;
          if (event.stage === 'complete') {
            completed = true;
            renderResult(event.result);
            mk.wechatMtlsCertificate = '';
            mk.wechatMtlsPrivateKey = '';
            $('mkWechatMtlsCertificate').value = '';
            $('mkWechatMtlsPrivateKey').value = '';
            showScreen('m4');
            continue;
          }
          updateProgress(event);
          if (event.status !== 'error') continue;
          failed = true;
          if (event.action === 'confirm_upgrade') {
            const choice = await confirmMakersUpgrade(mk.projectName, true);
            if (choice === 'upgrade') {
              applyMode('upgrade');
              errorEl.textContent = '已切换为无损升级，请点击“开始升级”。';
            } else {
              backToProjectName();
            }
          } else if (event.action === 'rename_project') {
            backToProjectName(event.message);
          } else {
            errorEl.textContent = `${event.message || '部署失败'}${event.detail ? `\n${event.detail}` : ''}${event.retryable ? '；可以直接重试。' : '；请返回修改配置后重试。'}`;
          }
        }
      }
      if (failed && earlySecrets) {
        showEarlySecrets(earlySecrets);
        applyMode('upgrade');
      }
      if (!completed && !failed) errorEl.textContent = '部署连接提前结束，没有收到完成状态，请重试。';
    } catch {
      errorEl.textContent = '部署进度连接中断，请确认网络后重试。';
      if (earlySecrets) {
        showEarlySecrets(earlySecrets);
        applyMode('upgrade');
      }
    } finally {
      button.disabled = false;
      $('m3-back').disabled = false;
      button.textContent = mk.mode === 'upgrade' ? '开始升级' : '开始部署';
    }
  });

  // --- m4: 结果 ---
  function renderResult(result) {
    const list = $('mk-result-list');
    list.innerHTML = '';
    $('mk-complete-title').textContent = result.mode === 'upgrade' ? '升级完成' : '部署完成';
    $('mk-result-hint').textContent = result.mode === 'upgrade'
      ? '程序已升级，原配置和数据保持不变。'
      : '请先复制保存以下凭据，关闭页面后不再展示。然后绑定域名、配置定时轮询，再进入后台配置收款通道。';
    list.appendChild(resultRow('访问地址', result.accessUrl));
    list.appendChild(resultRow('管理后台', result.adminUrl));
    if (result.presetUrl) list.appendChild(resultRow('Makers 默认域名', result.presetUrl));
    if (result.previewAdminUrl && !result.domainBound) {
      list.appendChild(resultRow('后台预览链接（3 小时内有效，绑定域名前用它进后台）', result.previewAdminUrl));
    }
    list.appendChild(resultRow('Makers 控制台', result.consoleUrl));
    if (result.healthWarning) list.appendChild(resultRow('检查提示', result.healthWarning));
    if (result.mode === 'upgrade') {
      list.appendChild(resultRow('保留内容', '数据库、插件配置、支付通道、密钥、定时轮询地址和域名绑定'));
    } else {
      list.appendChild(resultRow('管理员用户名', result.adminUsername));
      for (const [key, label] of Object.entries(SECRET_LABELS)) {
        if (result[key]) list.appendChild(resultRow(label, result[key]));
      }
    }

    $('mk-domain-steps').hidden = result.domainBound;
    $('mk-console-link').href = result.consoleUrl;
    document.querySelectorAll('.mk-domain').forEach((element) => { element.textContent = result.domain; });

    const pollList = $('mk-poll-list');
    pollList.innerHTML = '';
    if (result.tickUrl) {
      pollList.appendChild(resultRow('定时轮询地址（每 7～15 秒访问一次）', result.tickUrl));
      pollList.appendChild(resultRow('常驻运行的 Docker 命令（每 10 秒一次）', pollCommand(result.tickUrl)));
    } else {
      pollList.appendChild(resultRow('定时轮询', '升级不改变轮询地址，原来的定时器继续用即可；还没配的话，到后台“使用文档 → 定时轮询”复制地址和命令'));
    }
    $('mk-open-admin').href = result.domainBound ? result.adminUrl : result.previewAdminUrl || result.adminUrl;
  }
})();
