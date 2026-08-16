PRAGMA foreign_keys = ON;

-- 单租户：没有 merchants、plugin configs、routes、ledger、settlement 或 Redis 任务表。
CREATE TABLE IF NOT EXISTS payment_attempts (
  payment_no TEXT PRIMARY KEY,
  external_order_no TEXT NOT NULL UNIQUE,
  plugin_code TEXT NOT NULL,
  expected_amount_fen INTEGER NOT NULL CHECK (expected_amount_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAYING', 'PAID', 'CLOSED', 'EXPIRED', 'FAILED')),
  notify_url TEXT NOT NULL DEFAULT '',
  provider_trade_no TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  expires_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_plugin_status_expire
  ON payment_attempts(plugin_code, status, expires_at);

-- 收款信号先以 source + event_id 去重；任何重复投递都不会重复改变订单状态。
CREATE TABLE IF NOT EXISTS receipt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payment_no TEXT NOT NULL DEFAULT '',
  provider_trade_no TEXT NOT NULL DEFAULT '',
  amount_fen INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('RECEIVED', 'PROCESSED', 'REJECTED')),
  reason TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL,
  UNIQUE(source, event_id)
);

CREATE INDEX IF NOT EXISTS idx_receipt_events_payment_no ON receipt_events(payment_no);

-- D1 自身保存通知重试状态，Cron Trigger 只扫描这一张小表。
CREATE TABLE IF NOT EXISTS notification_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no TEXT NOT NULL UNIQUE,
  notify_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'RETRY', 'SENT', 'GAVE_UP')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(payment_no) REFERENCES payment_attempts(payment_no)
);

CREATE INDEX IF NOT EXISTS idx_notification_tasks_due
  ON notification_tasks(status, next_attempt_at);

-- 管理台可编辑配置只占用现有 D1 的两行：插件配置为 AES-GCM 密文，
-- 通道路由为非敏感 JSON。没有新增 KV、Queue 或独立数据库服务。
CREATE TABLE IF NOT EXISTS runtime_settings (
  setting_key TEXT PRIMARY KEY,
  value_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 单租户没有商户资金账本；冻结记录只用于阻止补单、查单、通知和退款等高风险后台动作。
CREATE TABLE IF NOT EXISTS order_controls (
  payment_no TEXT PRIMARY KEY,
  is_frozen INTEGER NOT NULL DEFAULT 0 CHECK (is_frozen IN (0, 1)),
  freeze_reason TEXT NOT NULL DEFAULT '',
  frozen_at TEXT,
  unfreeze_reason TEXT NOT NULL DEFAULT '',
  unfrozen_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(payment_no) REFERENCES payment_attempts(payment_no)
);

-- 保留原后台的支付单操作审计；不保存管理员密码或支付密钥。
CREATE TABLE IF NOT EXISTS order_operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  result_status TEXT NOT NULL,
  result_message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(payment_no) REFERENCES payment_attempts(payment_no)
);

CREATE INDEX IF NOT EXISTS idx_order_operation_logs_payment
  ON order_operation_logs(payment_no, created_at);

-- API 退款和手动退款共用退款单；CREATED/PROCESSING/SUCCEEDED 金额会占用可退余额，
-- 避免并发部分退款累计超过原支付金额。
CREATE TABLE IF NOT EXISTS refund_orders (
  refund_no TEXT PRIMARY KEY,
  merchant_refund_no TEXT NOT NULL DEFAULT '',
  payment_no TEXT NOT NULL,
  refund_amount_fen INTEGER NOT NULL CHECK (refund_amount_fen > 0),
  method TEXT NOT NULL CHECK (method IN ('API', 'MANUAL')),
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CLOSED')),
  provider_refund_no TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  provider_result_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(payment_no) REFERENCES payment_attempts(payment_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_orders_merchant_no
  ON refund_orders(merchant_refund_no)
  WHERE merchant_refund_no <> '';

CREATE INDEX IF NOT EXISTS idx_refund_orders_payment_status
  ON refund_orders(payment_no, status, created_at);
