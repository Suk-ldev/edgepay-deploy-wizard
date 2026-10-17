const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/**
 * 安卓监听端（APP APK 与 root 模块 zip）的最新版本。
 *
 * 版本钉在 wrangler.toml [vars]，随发行手动推进——和 TEMPLATE_VERSION 同一套节奏。
 * APP 与模块据此做更新检查：模块自带定时检查写进日志和状态；APP 在工具页提供
 * 手动检查。未配置时返回 200 + available:false，客户端把"没配置"当成"无新版"，
 * 而不是当成一次失败。
 */
export function handleWatcherVersion(env) {
  const appVersion = String(env.WATCHER_APP_VERSION ?? '').trim();
  const moduleVersion = String(env.WATCHER_MODULE_VERSION ?? '').trim();
  if (!VERSION_RE.test(appVersion) || !VERSION_RE.test(moduleVersion)) {
    return Response.json({ ok: true, available: false }, {
      headers: { 'cache-control': 'no-store' },
    });
  }
  return Response.json({
    ok: true,
    available: true,
    app: {
      version: appVersion,
      url: '/edgepay-watcher-android.apk',
    },
    module: {
      version: moduleVersion,
      url: '/edgepay-node-module.zip',
    },
  }, { headers: { 'cache-control': 'no-store' } });
}
