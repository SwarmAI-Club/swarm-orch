const path = require("path");
const fs = require("fs");
const express = require("express");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const CONFIG = process.env.SWARM_CONFIG || path.join(__dirname, "..", "config", "nodes.json");
const PORT = process.env.SWARM_ROUTER_PORT || 4900;
const CREDIT_RATE_PM = Number(process.env.SWARM_CREDIT_RATE_PM || 10); // legacy SWAI per GPU-min (vote) — replaced by token-based
const UPTIME_RATE_PM = Number(process.env.SWARM_UPTIME_RATE_PM || 2);  // legacy SWAI per idle min — replaced by token-based
const NET_TOKEN = process.env.SWARM_API_TOKEN || "dev-insecure-token"; // REQUIRED, all endpoints check it
// ---- SWAI economy v2 (tokens-based) ----
const SWAI_TOKENS = Number(process.env.SWAI_TOKENS || 10000);      // 1 SWAI = N tokens (input/output 基底)
const RATE_IN = Number(process.env.SWAI_RATE_IN || 5000);          // 1 SWAI charges per N INPUT tokens  (較平)
const RATE_OUT = Number(process.env.SWAI_RATE_OUT || 1000);        // 1 SWAI charges per N OUTPUT tokens (貴 5x)
const IMAGE_UNIT_PRICE = Number(process.env.SWAI_IMAGE_UNIT_PRICE || 20);   // image-gen 每 job unit→SWAI
const VIDEO_UNIT_PRICE = Number(process.env.SWAI_VIDEO_UNIT_PRICE || 80);   // video-gen 每 job unit→SWAI
// ---- USDC on Polygon 充值 ----
const USDC_TO_SWAI = Number(process.env.SWAI_USDC_RATE || 100);            // 1 USDC = 100 SWAI
const MIN_USDC_TOPUP = Number(process.env.SWAI_MIN_USDC || 5);              // 最低充值（USDC）
const USDC_CONTRACT = process.env.POLYGON_USDC || "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"; // USDC.e / native USDC on Polygon
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const depositWallet = process.env.SWARM_DEPOSIT_WALLET || "";               // 你嘅 USDC 收款地址（single-address plan）
const SYSTEM_ACCOUNT = "^system^";                                  // NET_TOKEN 用 account（monitor/admin）

// SMTP (forgot-password) — env 或 swarm-support-bot.env
const SMTP = { user: process.env.SWARM_SMTP_USER, pass: process.env.SWARM_SMTP_PASS, host: "smtp.zoho.com", port: 465 };
if (!SMTP.user || !SMTP.pass) {
  try {
    const fsx = require("fs");
    const txt = fsx.readFileSync("/mnt/d/docker_nginx/swarm-support-bot.env", "utf8");
    for (const ln of txt.split("\n")) {
      if (ln.startsWith("SWARM_SMTP_USER=")) SMTP.user = ln.split("=").slice(1).join("=").trim();
      if (ln.startsWith("SWARM_SMTP_PASS=")) SMTP.pass = ln.split("=").slice(1).join("=").trim();
    }
  } catch (e) {}
}


// ---- Time-Bank ledger (SWAI, SQLite) ----
const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "ledger.db"));
// credits: key = ACCOUNT(account/email)；歸戶，用戶 5 node 全入同一 account
db.exec(`CREATE TABLE IF NOT EXISTS credits(
  account TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  account TEXT NOT NULL,
  node_id TEXT,
  task_id TEXT,
  gpu_min REAL,
  credit INTEGER NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  units INTEGER DEFAULT 0,
  kind TEXT,
  note TEXT
)`);
// 檢查 versions 表有冇做過 migration
const oldCredits = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credits_old'").get();
if (!oldCredits && db.prepare("SELECT COUNT(*) c FROM credits").get().c > 0) {
  // 舊 credits 係 node_id key；開新表 credits_old 保留 + 唔自動清
  db.exec("ALTER TABLE credits RENAME TO credits_old");
  db.exec(`CREATE TABLE IF NOT EXISTS credits(
    account TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0
  )`);
}
// 舊 ledger 加新欄（tokens_in/out/kind/account）—— 用 ALTER 有缺就補
(function migrateLedger() {
  const cols = db.prepare("PRAGMA table_info(ledger)").all().map(c => c.name);
  const adds = [];
  if (!cols.includes("tokens_in")) adds.push("ADD COLUMN tokens_in INTEGER DEFAULT 0");
  if (!cols.includes("tokens_out")) adds.push("ADD COLUMN tokens_out INTEGER DEFAULT 0");
  if (!cols.includes("units")) adds.push("ADD COLUMN units INTEGER DEFAULT 0");
  if (!cols.includes("kind")) adds.push("ADD COLUMN kind TEXT");
  if (!cols.includes("account")) adds.push("ADD COLUMN account TEXT");
  for (const a of adds) db.exec(`ALTER TABLE ledger ${a}`);
})();
// tokens → SWAI：input 用 RATE_IN，output 用 RATE_OUT（最少 1）。tierMult 需求收費倍率
function tokensToCredit(tokensIn, tokensOut, tierMult = 1.0) {
  const sIn = Math.round((tokensIn || 0) / RATE_IN);
  const sOut = Math.round((tokensOut || 0) / RATE_OUT);
  // tier 只影響需求方收費：fast 用豪tier → 貴啲；normal → 平
  const base = Math.max(1, sIn + sOut);
  return Math.max(1, Math.round(base * tierMult));
}
function ledgerMint(account, opts = {}) {
  const { tokensIn = 0, tokensOut = 0, units = 0, unitPrice = 0, taskId = null, note = "", nodeId = "", kind = "vote" } = opts;
  // specialty unit 計費：units × unitPrice（如 image-gen 每張 N SWAI）；text/vision 照 token
  const credit = units > 0 ? Math.max(1, Math.round(units * unitPrice)) : tokensToCredit(tokensIn, tokensOut);
  db.prepare("INSERT INTO credits(account,balance) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET balance=balance+?")
    .run(account, credit, credit);
  db.prepare("INSERT INTO ledger(ts,type,account,node_id,task_id,gpu_min,credit,tokens_in,tokens_out,units,kind,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(Date.now(), "mint", account, nodeId || "", taskId || null, 0, credit, tokensIn || 0, tokensOut || 0, units || 0, kind || "vote", note);
  return credit;
}
function ledgerBurn(account, credit, taskId, note = "") {
  const bal = creditBalance(account);
  const actual = Math.min(credit, bal);
  db.prepare("UPDATE credits SET balance=balance-? WHERE account=?").run(actual, account);
  db.prepare("INSERT INTO ledger(ts,type,account,node_id,task_id,gpu_min,credit,tokens_in,tokens_out,units,kind,note) VALUES(?,?,?,?,?,?,?,0,0,0,?,?)")
    .run(Date.now(), "burn", account, "", taskId || null, 0, actual, "task", note);
  return actual;
}
// ---- Daily burn quota (防 key 被偷時一夜清空) ----
const DAILY_BURN_CAP = Number(process.env.SWARM_DAILY_BURN_CAP || 2000); // 每 account 每日 SWAI burn 上限
function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
function dailyUsed(account) {
  const r = db.prepare("SELECT total FROM daily_usage WHERE account=? AND day=?").get(String(account), dayKey());
  return r ? Number(r.total) || 0 : 0;
}
function dailyAdd(account, swai) {
  db.prepare("INSERT INTO daily_usage(account, day, total) VALUES(?,?,?) ON CONFLICT(account, day) DO UPDATE SET total=total+?")
    .run(String(account), dayKey(), swai, swai);
}
function dailyQuotaRemaining(account) {
  return Math.max(0, DAILY_BURN_CAP - dailyUsed(account));
}
function ledgerBurnChecked(account, credit, taskId, note = "") {
  const remaining = dailyQuotaRemaining(account);
  if (credit > remaining) return { burned: ledgerBurn(account, remaining, taskId, note), remaining, capped: true, cap: DAILY_BURN_CAP };
  const burned = ledgerBurn(account, credit, taskId, note);
  dailyAdd(account, burned);
  return { burned, remaining: remaining - burned, capped: false, cap: DAILY_BURN_CAP };
}
// specialty（image/video）落單計費：單位 × 單位價
function specialtyFee(units, unitPrice) {
  return Math.max(1, Math.round(units * unitPrice));
}
// token → account（歸戶 key：所有 worker/API 用同一 user token 都入同一 email account）
function accountForToken(t) {
  if (!t) return null;
  if (t === NET_TOKEN) return SYSTEM_ACCOUNT;
  const u = findUserByToken ? findUserByToken(t) : null;
  return u ? u.email : null;
}

// ---- Logical model map (OpenAI gateway) ----
// 對外 model ID → 派工群組 + tier 收費倍率
const MODEL_MAP = {
  "swarmai-fast":     { cap: ["reasoning", "analysis"], tier: ["S", "A"], n_votes: 3, label: "勁機優先（5090/4090/2080Ti），貴" },
  "swarmai-normal":   { cap: ["reasoning", "math"], tier: ["B", "C"], n_votes: 3, label: "日常平價（3060/2060 及以下）" },
  "swarmai-vision": { cap: ["vision"], tier: ["S", "A", "B", "C"], n_votes: 1, vision: true, hidden: true, label: "Vision (auto-route, 唔對外顯示)" },
  "swarmai-free":     { cap: ["reasoning", "math", "analysis"], tier: ["S", "A", "B", "C"], n_votes: 3, freeOnly: true, label: "免費 node（自由分享）——唔扣費" },
  "swarmai-image":    { cap: ["image-gen"], tier: ["A", "B", "C"], n_votes: 1, unit: true, unitPer: "job", unitPrice: IMAGE_UNIT_PRICE, max_units: 4, label: "圖像生成（SD-WebUI/ComfyUI adapter）——每張按 unit 計" },
  "swarmai-video":    { cap: ["video-gen"], tier: ["A", "B", "C"], n_votes: 1, unit: true, unitPer: "job", unitPrice: VIDEO_UNIT_PRICE, max_units: 8, label: "視訊生成（Wan adapter）——每條按 unit 計" },
};
// tier 收費倍率（需求方）同一緊 mint（供應方）用
const TIER_RATE = { S: 1.8, A: 1.3, B: 1.0, C: 0.6 };       // 需求方收費
const TIER_MINT = { S: 1.8, A: 1.3, B: 1.0, C: 0.7 };       // 供應方 mint
// node → tier（由 gpu/vram 簡單判定；register 可帶 gpu 名）
const R_SECRET = process.env.SWARM_ROUTER_SECRET || NET_TOKEN; // 派工簽名 secret
function signAssign(taskId, nodeId) {
  return crypto.createHmac("sha256", String(R_SECRET)).update(`${taskId}::${nodeId}`).digest("hex");
}
function verifyAssign(taskId, nodeId, sig) {
  if (!sig) return false;
  const expect = signAssign(taskId, nodeId);
  return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}
function nodeTier(n) {
  const g = String(n.gpu || "").toLowerCase();
  const v = n.vram || 0;
  if (/5090|4090|3090/.test(g) || v >= 24) return "S";
  if (/2080|2080ti|30\s?/i.test(g) || v >= 20) return "A";
  if (v >= 10) return "B";
  return "C";
}
// 探 backend 能力（tools / thinking / vision）by completion URL -> /props
async function probeAbilities(completionUrl) {
  try {
    const u = new URL(completionUrl);
    const props = u.protocol === "http:" ? `http://${u.host}/props` : `https://${u.host}/props`;
    const r = await fetch(props, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const caps = d.chat_template_caps || {};
    const mod = d.modalities || {};
    return {
      tools: !!(caps.supports_tools || caps.supports_tool_calls),
      thinking: !!caps.supports_preserve_reasoning,
      vision: mod.vision === true,
      ctx: (d.default_generation_settings || {}).n_ctx || 0,
    };
  } catch (e) {
    return { tools: null, thinking: null, vision: null, ctx: 0, error: String(e.message || e).slice(0, 60) };
  }
}
function tierCharge(tier) { return TIER_RATE[tier] || 1.0; }

// ---- Rating engine (profile 顯示) ----
function gradeFor(score) { return score >= 90 ? "S" : score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D"; }
function computeRating(node) {
  // 5 維（Accuracy beta 唔落）→ 0-100
  const spd = parseFloat(node.speed) || 0;
  const speedScore = Math.min(100, Math.round((spd / 40) * 100));       // 40 tok/s = 100
  const availScore = 100;                                               // heartbeat 有 = 100（簡化）
  const capScore = Math.min(100, Math.round(((node.max_context || 0) / 65536) * 100));
  const trustScore = Math.max(0, 100 - ((node.trust_penalty || 0)));
  const score = Math.round(speedScore * 0.5 + availScore * 0.25 + capScore * 0.15 + trustScore * 0.10);
  return { score, grade: gradeFor(score), dimensions: { speed: speedScore, availability: availScore, capacity: capScore, trust: trustScore, accuracy: null } };
}
function creditBalance(account) {
  return db.prepare("SELECT balance FROM credits WHERE account=?").get(account)?.balance || 0;
}
// ---- Client portal: users (email login -> own API token) ----
db.exec(`CREATE TABLE IF NOT EXISTS users(
  email TEXT PRIMARY KEY,
  pass_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  node_id TEXT NOT NULL,
  created INTEGER
)`);
// profile 可更新欄（migration，有一缺一）
(function migrateUsers() {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  const adds = [];
  if (!cols.includes("display_name")) adds.push("display_name TEXT");
  if (!cols.includes("pref_model")) adds.push("pref_model TEXT DEFAULT 'swarmai-normal'");
  if (!cols.includes("timezone")) adds.push("timezone TEXT DEFAULT 'UTC'");
  if (!cols.includes("sleep_start_hour")) adds.push("sleep_start_hour INTEGER DEFAULT 0");
  if (!cols.includes("sleep_end_hour")) adds.push("sleep_end_hour INTEGER DEFAULT 7");
  if (!cols.includes("share_default")) adds.push("share_default INTEGER DEFAULT 100");
  if (!cols.includes("max_budget_per_task")) adds.push("max_budget_per_task INTEGER DEFAULT 0");
  if (!cols.includes("dispatch_pref")) adds.push("dispatch_pref TEXT DEFAULT 'self'");
  if (!cols.includes("usdc_deposit_addr")) adds.push("usdc_deposit_addr TEXT");
  for (const a of adds) db.exec(`ALTER TABLE users ADD COLUMN ${a}`);
})();
db.exec(`CREATE TABLE IF NOT EXISTS deposits(
  tx_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  sender TEXT NOT NULL,
  amount_usdc REAL DEFAULT 0,
  swai INTEGER DEFAULT 0,
  ts INTEGER,
  confirmations INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_resets(
  email TEXT,
  code TEXT PRIMARY KEY,
  created INTEGER,
  used INTEGER DEFAULT 0
)`);
// Pilot 優惠：promo 表 + 開戶送分
db.exec(`CREATE TABLE IF NOT EXISTS promotions(
  code TEXT PRIMARY KEY,
  kind TEXT,           -- discount（消費折扣）| reward（兌換即加 token）
  scope TEXT,          -- tier/model/account/all
  value REAL,          -- discount=折扣比(0.5五折)；reward=加幾多 SWAI
  valid_from INTEGER,
  valid_to INTEGER,
  max_uses INTEGER,
  used INTEGER DEFAULT 0,
  per_user INTEGER DEFAULT 1
)`);
db.exec(`CREATE TABLE IF NOT EXISTS promo_uses(
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  ts INTEGER,
  PRIMARY KEY(email, code)
)`);
(function migratePromos() {
  const cols = db.prepare("PRAGMA table_info(promotions)").all().map(c => c.name);
  if (!cols.includes("per_user")) db.exec("ALTER TABLE promotions ADD COLUMN per_user INTEGER DEFAULT 1");
})();
const SIGNUP_BONUS = Number(process.env.SWARM_SIGNUP_BONUS || 50); // Pilot: 開戶送分
// per-node owner settings（free/sleep/share/suspend 持久化；node 級覆寫 user 預設）
db.exec(`CREATE TABLE IF NOT EXISTS node_settings(
  node_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  free INTEGER DEFAULT 0,
  sleep_start_hour INTEGER,
  sleep_end_hour INTEGER,
  share_ratio INTEGER,
  suspend INTEGER DEFAULT 0,
  updated INTEGER
)`);
(function migrateNodeSettings() {
  const cols = db.prepare("PRAGMA table_info(node_settings)").all().map(c => c.name);
  const adds = [];
  if (!cols.includes("sleep_start_hour")) adds.push("ADD COLUMN sleep_start_hour INTEGER");
  if (!cols.includes("sleep_end_hour")) adds.push("ADD COLUMN sleep_end_hour INTEGER");
  if (!cols.includes("share_ratio")) adds.push("ADD COLUMN share_ratio INTEGER");
  if (!cols.includes("suspend")) adds.push("ADD COLUMN suspend INTEGER DEFAULT 0");
  if (!cols.includes("removed")) adds.push("ADD COLUMN removed INTEGER DEFAULT 0");
  for (const a of adds) db.exec(`ALTER TABLE node_settings ${a}`);
})();
function nodeSettingFree(nodeId) { return (db.prepare("SELECT free FROM node_settings WHERE node_id=?").get(nodeId) || {}).free || 0; }
function nodeSetting(nodeId) { return db.prepare("SELECT * FROM node_settings WHERE node_id=?").get(String(nodeId)) || {}; }
// 唔列為候選：suspend=1（暫停接工）或未註冊
function nodeSuspended(nodeId) { return !!(nodeSetting(nodeId).suspend); }
// 被主人移除（換機/重裝）：心跳唔再自動復活
function nodeRemoved(nodeId) { return !!(nodeSetting(nodeId).removed); }
function nodeShareOverride(nodeId) {
  const v = nodeSetting(nodeId).share_ratio;
  return v === null || v === undefined || v === "" ? null : Math.max(0, Math.min(100, Number(v)));
}
function promoValid(code) {
  if (!code) return null;
  const row = db.prepare("SELECT * FROM promotions WHERE code=?").get(String(code));
  if (!row) return null;
  const now = Date.now();
  if (row.valid_from && now < row.valid_from) return null;
  if (row.valid_to && now > row.valid_to) return null;
  if (row.max_uses && row.used >= row.max_uses) return null;
  return row;
}
// 應用 promo（discount：value=折扣比例，0.5 = 五折）；扣費時計算實收費　並　標記已用
function applyPromoToFee(code, fee) {
  const p = promoValid(code);
  if (!p) return { fee, promo: null };
  if (p.kind === "discount" && p.scope === "all") {
    const discounted = Math.max(0, Math.round(fee * (p.value || 1)));
    db.prepare("UPDATE promotions SET used = used + 1 WHERE code=?").run(code);
    return { fee: discounted, promo: { code, discount: p.value } };
  }
  return { fee, promo: { code, note: "kind/scope 唔支援收費折扣" } };
}
function promoFromReq(req) {
  return String((req.body && req.body.promo) || req.get("x-swarm-promo") || "").trim();
}
// 兌換 promo（reward kind：用咗就加 token 入 account）—— 每人每次限一次、週期內有效
function redeemPromo(code, email) {
  const p = promoValid(code);
  if (!p) return { ok: false, error: "coupon 無效或過期" };
  if (p.kind !== "reward") return { ok: false, error: "呢張 coupon 唔係兌換型" };
  if (p.per_user && db.prepare("SELECT 1 FROM promo_uses WHERE email=? AND code=?").get(email, code))
    return { ok: false, error: "你用過呢張 coupon 喇" };
  if (p.max_uses && p.used >= p.max_uses) return { ok: false, error: "coupon 已用晒" };
  const swai = Math.round(p.value || 0);
  ledgerMint(email, { tokensIn: 0, tokensOut: swai * RATE_OUT, taskId: null, note: `promo_${code}`, nodeId: "", kind: "reward" });
  db.prepare("INSERT INTO promo_uses(email, code, ts) VALUES(?,?,?)").run(email, code, Date.now());
  db.prepare("UPDATE promotions SET used = used + 1 WHERE code=?").run(code);
  return { ok: true, credited: swai, remainingBal: creditBalance(email) };
}
db.exec(`CREATE TABLE IF NOT EXISTS user_keys(
  email TEXT NOT NULL,
  token TEXT PRIMARY KEY,
  label TEXT,
  created INTEGER,
  scope TEXT DEFAULT 'full',
  last_used_at INTEGER,
  last_ip TEXT
)`);
db.exec(`INSERT OR IGNORE INTO user_keys(email, token, label, created) SELECT email, token, 'primary', created FROM users`);
(function migrateKeys() {
  const cols = db.prepare("PRAGMA table_info(user_keys)").all().map(c => c.name);
  const adds = [];
  if (!cols.includes("scope")) adds.push("ADD COLUMN scope TEXT DEFAULT 'full'");
  if (!cols.includes("last_used_at")) adds.push("ADD COLUMN last_used_at INTEGER");
  if (!cols.includes("last_ip")) adds.push("ADD COLUMN last_ip TEXT");
  for (const a of adds) db.exec(`ALTER TABLE user_keys ${a}`);
  db.exec("UPDATE user_keys SET scope='full' WHERE scope IS NULL OR scope=''");
})();
db.exec(`CREATE TABLE IF NOT EXISTS node_owners(
  node_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  created INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS daily_usage(
  account TEXT NOT NULL,
  day TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  PRIMARY KEY(account, day)
)`);
function hashPass(p) { return crypto.scryptSync(String(p), "swaimail", 32).toString("hex"); }
function mkNodeId(email) {
  return "client-" + String(email).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
// 每 user 一條 deterministic「充值代號」——user 轉 USDC 時喺 tx note/memo 或轉返自己名下地址辨識。
// 方案 A（單一接收地址）：用 deposit_wallet + sender 自動 bind；此處只做 memo 標記（'' = 唔需要）
function mkDepositRef(email) {
  return crypto.createHash("sha256").update(email + process.env.SWARM_DEPOSIT_SALT || "swarm").digest("hex").slice(0, 16);
}
function ensureDepositAddr(email) {
  const row = db.prepare("SELECT usdc_deposit_addr FROM users WHERE email=?").get(email) || {};
  if (row.usdc_deposit_addr) return row.usdc_deposit_addr;
  const addr = mkDepositRef(email);
  db.prepare("UPDATE users SET usdc_deposit_addr=? WHERE email=?").run(addr, email);
  return addr;
}
function mkToken() { return "swai-" + crypto.randomBytes(16).toString("hex"); }
function findUserByToken(t) {
  return db.prepare("SELECT u.email, u.node_id, u.created AS acct_created, k.token, k.label, k.scope, k.last_used_at, k.last_ip FROM user_keys k JOIN users u ON u.email=k.email WHERE k.token=?").get(String(t));
}
function listKeysByToken(t) {
  return db.prepare("SELECT token, label, created, scope, last_used_at, last_ip FROM user_keys WHERE email=(SELECT email FROM user_keys WHERE token=?)").all(String(t));
}
const keyLastTouch = new Map(); // token -> ts（touch debounce 60s）
function touchKeyUse(t, ip) {
  if (!t) return;
  const now = Date.now();
  if (now - (keyLastTouch.get(t) || 0) < 60 * 1000) return;
  keyLastTouch.set(t, now);
  try {
    db.prepare("UPDATE user_keys SET last_used_at=?, last_ip=? WHERE token=?").run(now, String(ip || "").slice(0, 64), String(t));
  } catch (e) {}
}
// key scope：full（全功能）| client（落單用，唔可以註冊 worker）| worker（掛機用，唔可以落單）
function keyScopeOf(t) {
  if (!t || t === NET_TOKEN) return "full";
  const u = findUserByToken(t);
  return (u && u.scope) || "full";
}
const SCOPE_WORKER_ENDPOINTS = new Set(["/register", "/status", "/tasks/poll", "/beacon", "/assign", "/result", "/vote"]);
// node_id 綁定：node 屬於邊個 account（防搶註冊 / 冒充）
function nodeOwner(node_id) {
  return db.prepare("SELECT account, created FROM node_owners WHERE node_id=?").get(String(node_id));
}
function claimNode(node_id, account, force = false) {
  const sql = force
    ? "INSERT INTO node_owners(node_id, account, created) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET account=excluded.account"
    : "INSERT OR IGNORE INTO node_owners(node_id, account, created) VALUES(?,?,?)";
  db.prepare(sql).run(String(node_id), account, Date.now());
  return nodeOwner(node_id);
}
function userByEmail(e) { return db.prepare("SELECT * FROM users WHERE email=?").get(String(e).toLowerCase()); }

const nodes = require(CONFIG);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// ---- Auth: all endpoints require X-Swarm-Token ----
app.use((req, res, next) => {
  const p0 = req.path;
  if (p0.startsWith("/portal")) return next();
  if (p0 === "/v1/pay/verify") return next();   // 公開支付核實（只驗 on-chain tx，唔涉 account）
  let t = req.get("x-swarm-token");
  if (!t) {
    // OpenAI-compatible: Authorization: Bearer sk-swai-... or Bearer <token>
    const auth = String(req.get("authorization") || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) t = m[1].replace(/^sk-swai-/, "swai-").replace(/^sk-/, "");
  }
  if (t !== NET_TOKEN && !findUserByToken(t)) return res.status(401).json({ ok: false, error: "invalid x-swarm-token" });
  req.swarmToken = t;
  touchKeyUse(t, req.connection?.remoteAddress || req.headers["x-forwarded-for"]);
  // scope 執行：worker-only 保證 key 唔可以做消耗；client-only 保證 key 唔可以註冊/冒充 worker
  if (t !== NET_TOKEN) {
    const scope = keyScopeOf(t);
    const p = req.path.split("?")[0];
    if (scope === "client" && SCOPE_WORKER_ENDPOINTS.has(p)) {
      return res.status(403).json({ ok: false, error: "此 key 係 client scope（唔可以做 worker 操作）" });
    }
    if (scope === "worker" && (p === "/task" || p === "/v1/chat/completions" || p === "/ledger/mint" || p === "/ledger/burn")) {
      return res.status(403).json({ ok: false, error: "此 key 係 worker scope（唔可以落單/扣費）" });
    }
  }
  next();
});

const registry = new Map();       // node_id -> capabilities/model/gpu/url
const pendingBeacons = new Map(); // beacon_id -> {required, responses, ts}
const resultsStore = new Map();   // task_id -> {ts, list: task_result[]}
const inbox = new Map();          // node_id -> [{task_id,prompt,n_votes,temperature}] (pull mode)

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / new Set([...A, ...B]).size;
}

// ---- 離線偵測：>5min 冇心跳 = offline（唔派工）----
const NODE_STALE_MS = Number(process.env.SWARM_NODE_STALE_MS || 5 * 60 * 1000);
function nodeOnline(n) {
  if (!n) return false;
  const last = n.last_status && n.last_status.__tsMs;
  return !!last && (Date.now() - last) < NODE_STALE_MS;
}
function nodeLastSeenMin(n) {
  const last = n.last_status && n.last_status.__tsMs;
  if (!last) return null;
  return Math.round((Date.now() - last) / 60000);
}
// ---- User dispatch_pref：self（自己機優先，default）| fastest（唔理自己優先）| free-first（自己+free 一併優先）----
function dispatchPrefFor(email) {
  if (!email) return "self";
  const r = db.prepare("SELECT dispatch_pref FROM users WHERE email=?").get(email);
  return (r && r.dispatch_pref) || "self";
}
// 自己 account 嘅機（註冊咗嘅 active node）
function myNodes(account) {
  return [...registry.values()].filter(n => n.account === account && nodeOnline(n));
}

function matchCapabilities(required, candidates, reqAcc) {
  const pref = dispatchPrefFor(reqAcc);
  return candidates
    .filter(n => Array.isArray(n.capabilities))
    .filter(n => n.node_id ? !nodeSuspended(n.node_id) : true)   // suspend 唔接工
    .filter(n => nodeOnline(n))                                    // 離線唔派工
    .map(n => {
      const base = jaccard(required, n.capabilities);
      const ov = nodeShareOverride(n.node_id);
      const ratio = Math.max(1, Math.min(100, ov !== null ? ov : (n.share_ratio !== undefined ? n.share_ratio : 100)));
      // rating 乘入派工優先（0.75–1.25x）；高分行食多單
      const rating = computeRating(n).score;
      const rMult = 0.75 + (rating / 100) * 0.5;
      // 自己機優先：self / free-first 加權 1.5x
      const ownMult = (reqAcc && n.account === reqAcc && pref !== "fastest") ? 1.5 : 1.0;
      return { node: n, score: base * (ratio / 100) * rMult * ownMult };   // ratio 低 → 派工優先度低（防蜂擁）
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

app.post("/register", (req, res) => {
  const { node_id, capabilities, model, gpu, max_context, speed, share_ratio, url, free } = req.body;
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  const tk = req.get("x-swarm-token");
  const acc = accountForToken(tk) || SYSTEM_ACCOUNT;
  // SSRF 防護：只有 NET_TOKEN(admin)/平台自身 node 先可以 push（router 主動 fetch 去 node.url）。
  // 普通 user token 註冊嘅 node → 一律強制 pull（inbox queue），router 唔會 fetch 佢填嘅 url。
  const isAdmin = tk === NET_TOKEN;
  const isOwnerAcct = !!nodeOwner(node_id) && nodeOwner(node_id).account === acc;
  const forcePull = !isAdmin && !isOwnerAcct;
  // P2 綁定：node 只可以屬一個 account。若 node 已被其他 account 註冊 → 拒絕（防冒充）
  const own = nodeOwner(node_id);
  if (own && own.account !== acc) return res.status(403).json({ ok: false, error: `node ${node_id} 已註冊俾 ${own.account}` });
  if (!own) claimNode(node_id, acc);
  const n = registry.get(node_id) || { uptime_s: 0, last_status: null };
  // 重新註冊 = 重裝/換機後再上線 → 清 removed 標記
  db.prepare("UPDATE node_settings SET removed=0 WHERE node_id=?").run(node_id);
  Object.assign(n, { node_id, capabilities, model, gpu, max_context, speed, url, pull: forcePull ? true : !!req.body.pull });
  const so = nodeShareOverride(node_id);
  n.share_ratio = Math.max(0, Math.min(100, so !== null ? so : (share_ratio !== undefined ? share_ratio : (n.share_ratio || 100))));
  // free：DB owner 設定優先（持久）；無則用 register flag
  if (nodeSettingFree(node_id)) { n.free = true; n.free_manual = true; }
  else if (!n.free_manual) n.free = !!free;   // free node：owner 設定優先（心跳/register 唔覆寫）
  n.account = acc;
  if (req.body.completion) {
    n.completion = req.body.completion;
    probeAbilities(req.body.completion).then(a => { n.abilities = a; if (a.ctx) n.max_context = a.ctx; }).catch(() => {});
  }
  registry.set(node_id, n);
  res.json({ ok: true, nodes: registry.size, uptime_rate_pm: UPTIME_RATE_PM, credit_rate_pm: CREDIT_RATE_PM });
});

// protocol v0.2: node_status heartbeat (+ Proof-of-Uptime accumulation)
// IDLE_SHARING 時間差 → 按 node.speed 產能 mint（tokens → SWAI）歸入 node.account
app.post("/status", (req, res) => {
  const { node_id, status, vram_used_gb, model_loaded, load, sleeping, ts } = req.body || {};
  let n = registry.get(node_id);
  const tk = req.get("x-swarm-token");
  const acc = accountForToken(tk) || SYSTEM_ACCOUNT;
  // 心跳但未註冊（router 重啟後）→ 自動補註冊（node_id 已知；心跳帶返完整資料）
  if (!n && node_id) {
    // P2 綁定：已有 owner 且唔係自己 → 心跳唔可以強搶呢個 node（防冒充）
    // 被主人移除嘅 node：唔好俾心跳自動復活（換機/重裝場景）—— 心跳靜默 ack，唔註冊
    if (nodeRemoved(node_id)) return res.json({ ok: true, node_id, removed: true });
    const own = nodeOwner(node_id);
    if (own && own.account !== acc) return res.status(403).json({ ok: false, error: `node ${node_id} 已註冊俾 ${own.account}` });
    if (!own) claimNode(node_id, acc);
    n = { node_id, uptime_s: 0, last_status: null, capabilities: req.body.capabilities || [], url: "" };
    n.account = acc;
    // 跟心跳帶嘅 pull（平台 push worker 帶 false；外部 --pull worker 帶 true）。
    // SSRF 由 dispatch 層 nodePushAddrOK 保證（只會 fetch 去 BIND hosts），確定唔會 fetch 任意 url。
    n.pull = !!req.body.pull;
    n.speed = req.body.speed || "";
    n.gpu = req.body.gpu || "";
    n.vram = req.body.vram || 0;
    n.model = req.body.model || "";
    n.max_context = req.body.max_context || 0;
    n.share_ratio = Math.max(0, Math.min(100, Number(req.body.share_ratio !== undefined ? req.body.share_ratio : 100)));
    n.free = !!req.body.free;
    registry.set(node_id, n);
  }
  // 心跳帶咗最新 hardware 資料 → 更新（唔淨 auto-register）
  if (n) {
    if (req.body.gpu) n.gpu = req.body.gpu;
    if (req.body.vram) n.vram = req.body.vram;
    if (req.body.model) n.model = req.body.model;
    if (req.body.speed) n.speed = req.body.speed;
    if (req.body.url) n.url = req.body.url;
    if (req.body.completion && req.body.completion !== n.completion) {
      n.completion = req.body.completion;
      probeAbilities(req.body.completion).then(a => { n.abilities = a; if (a.ctx) n.max_context = a.ctx; }).catch(() => {});
    }
    if (req.body.max_context) n.max_context = req.body.max_context;
    if (req.body.free !== undefined && !n.free_manual) n.free = !!req.body.free;
    if (nodeSettingFree(node_id)) { n.free = true; n.free_manual = true; }
    if (Array.isArray(req.body.capabilities) && req.body.capabilities.length) n.capabilities = req.body.capabilities;
    const nowMs = Date.now();
    const tsS = (ts && ts < 1e12) ? Number(ts) : (nowMs / 1000);
    const last = n.last_status;
    if (last && last.__state === "IDLE_SHARING") { n.uptime_s += (nowMs - last.__tsMs) / 1000; }
    if (last && last.__state === "IDLE_SHARING" && status === "IDLE_SHARING") {
      // 連續 idle：呢段時間差 idle 產能 → mint（tok/s × sec → tokens）
      const dtSec = (nowMs - last.__tsMs) / 1000;
      const spd = parseFloat(n.speed) || 0;
      if (dtSec > 5 && spd > 0) {
        const acc = n.account || accountForToken(req.get("x-swarm-token")) || SYSTEM_ACCOUNT;
        const ov = nodeShareOverride(node_id);
        const ratio = Math.max(0, Math.min(100, ov !== null ? ov : (n.share_ratio !== undefined ? n.share_ratio : 100)));
        const tokens = Math.round(spd * dtSec * (ratio / 100));
        if (tokens > 0) {
          const c = ledgerMint(acc, { tokensIn: 0, tokensOut: tokens, taskId: null, note: "idle_uptime", nodeId: node_id, kind: "idle" });
          n.last_mint_idle = { ts: nowMs, tokens, credit: c };
          console.log(`[idle] ${node_id} +${c} SWAI (${tokens} tokens, ${dtSec.toFixed(0)}s idle, ratio ${ratio}%)`);
        }
      }
    }
    n.last_status = { status, vram_used_gb, model_loaded, load, sleeping, ts: tsS, __state: status, __tsMs: nowMs };
  }
  res.json({ ok: !!n, node_id });
});

app.post("/beacon", async (req, res) => {
  const { task, required_capabilities, priority = 1, deadline } = req.body;
  const beacon_id = crypto.randomUUID();
  const matches = matchCapabilities(required_capabilities, [...registry.values()], accountForToken(req.get("x-swarm-token")));

  const responses = [];
  for (const { node } of matches.slice(0, CONFIG.max_beacon_targets || 3)) {
    if (!nodePushAddrOK(node.url)) continue;   // SSRF 防護：beacon 都只 forward 去本機 BIND hosts
    try {
      const r = await fetch(`${node.url}/beacon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ beacon_id, task, required_capabilities, priority, deadline }),
        signal: AbortSignal.timeout(8000)
      });
      responses.push({ node: node.node_id, ...(await r.json()) });
    } catch (e) {
      console.log("[beacon] timeout/fail", node.node_id, e.message);
    }
  }
  pendingBeacons.set(beacon_id, { required: required_capabilities, responses, ts: Date.now() });
  res.json({ beacon_id, responses });
});

app.post("/result", (req, res) => {
  const { task_id, node_id, votes, duration_ms, tokens_in, tokens_out, images, units } = req.body || {};
  if (!task_id || !node_id) return res.status(400).json({ ok: false, error: "task_id&node_id required" });
  const rec = resultsStore.get(task_id);
  // P2 防偽：task 必須有派過俾呢個 node（assigned set）先收 result
  if (!rec || !rec.assigned || !rec.assigned.has(node_id))
    return res.status(403).json({ ok: false, error: "task 未指派俾呢個 node" });
  rec.list.push({ node_id, votes: votes || [], duration_ms: duration_ms || 0, tokens_in: tokens_in || 0, tokens_out: tokens_out || 0, images: images || [], units: units || 0 });
  resultsStore.set(task_id, rec);
  res.json({ ok: true, task_id, results: rec.list.length });
});

app.post("/vote", async (req, res) => {
  // aggregate task_results into weighted majority vote (reads stored /result entries)
  pendingBeacons.delete(req.body.beacon_id);
  const taskId = req.body.task_id;
  const stored = taskId && resultsStore.get(taskId);
  const results = stored ? stored.list : (req.body.results || []);
  const tally = {};
  for (const r of results) for (const v of r.votes || []) {
    const ans = String(v.content).trim();
    tally[ans] = (tally[ans] || 0) + (v.confidence || 0.5);
  }
  // Time-Bank v2: 每個 provider 按 實際 input+output tokens 折算 SWAI → 歸入 node.account
  const mints = [];
  for (const r of results) {
    const acc = (r._account) || (registry.get(r.node_id)?.account) || SYSTEM_ACCOUNT;
    const tin = r.tokens_in || 0;
    const tout = r.tokens_out || 0;
    if (r.node_id) {
      const c = ledgerMint(acc, { tokensIn: tin, tokensOut: tout, taskId: r.task_id || req.body.task_id || null, note: "vote", nodeId: r.node_id, kind: "vote" });
      mints.push({ node_id: r.node_id, account: acc, credit: c, tokens_in: tin, tokens_out: tout });
    }
  }
  const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  // 精算：requester 實際應付 = 總 output tokens（providers mint 已由 /vote providers 各自計）
  // 多退：估費 vs 實際 providers 收到嘅 credits 差額退回 requester
  try {
    const tk = req.get("x-swarm-token");
    const reqAcc = tk ? accountForToken(tk) : null;
    const estFee = (stored && stored.est_fee) || 0;
    const providersTotal = mints.reduce((s, m) => s + m.credit, 0);
    if (estFee > providersTotal) {
      const refund = estFee - providersTotal;
      if (reqAcc && refund > 0) ledgerMint(reqAcc, { tokensIn: 0, tokensOut: Math.round(refund * RATE_OUT), taskId, note: "task_refund", nodeId: reqAcc, kind: "refund" });
    }
  } catch (e) {}
  res.json({ winner: winner?.[0], confidence: winner?.[1], tally, mints });
});

// ---- Time-Bank ledger endpoints ---- (account-based; 手動 mint/burn 只俾 admin/NET_TOKEN)
app.post("/ledger/mint", (req, res) => {
  const tk = req.get("x-swarm-token");
  if (tk !== NET_TOKEN) return res.status(403).json({ ok: false, error: "admin only" });
  const { account, tokens_in = 0, tokens_out = 0, task_id, node_id } = req.body || {};
  if (!account) return res.status(400).json({ ok: false, error: "account required" });
  const credit = ledgerMint(account, { tokensIn: Number(tokens_in), tokensOut: Number(tokens_out), taskId: task_id, note: "manual", nodeId: node_id || "", kind: "manual" });
  res.json({ ok: true, account, credit, balance: creditBalance(account) });
});

app.post("/ledger/burn", (req, res) => {
  const tk = req.get("x-swarm-token");
  if (tk !== NET_TOKEN) return res.status(403).json({ ok: false, error: "admin only" });
  const { account, credit, task_id } = req.body || {};
  if (!account || !credit) return res.status(400).json({ ok: false, error: "account & credit required" });
  const actual = ledgerBurn(account, Number(credit), task_id, "manual");
  res.json({ ok: true, account, burned: actual, balance: creditBalance(account) });
});

// ---- USDC on Polygon 充值（方案 A：單一接收地址＋sender 自動 bind / 人手 tx 核實）----
app.get("/portal/topup", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const addr = ensureDepositAddr(u.email);
  const pending = db.prepare("SELECT tx_hash, amount_usdc, confirmations, processed FROM deposits WHERE account=? ORDER BY ts DESC LIMIT 10").all(u.email);
  res.json({
    ok: true, wallet: depositWallet || null, min_usdc: MIN_USDC_TOPUP, rate: USDC_TO_SWAI, // 1 USDC = N SWAI
    deposit_addr: addr, steps: [
      "1) 攞你左邊而家嘅 USDC 地址，或直接睇返你 profile topup 卡",
      `2) 於任何錢包（MetaMask/Trust/交易所）轉 USDC (Polygon 網絡) 到收款地址，最）${MIN_USDC_TOPUP} USDC`,
      "3) 網絡確認後，喺度撳「我已轉帳」輸入 tx hash，或等我自動掃描入帳",
    ],
    pending,
  });
});

app.post("/portal/topup/submit", async (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const tx = String((req.body || {}).tx || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return res.status(400).json({ ok: false, error: "tx hash 格式唔啱（0x…64 hex）" });
  const exists = (db.prepare("SELECT account FROM deposits WHERE tx_hash=?").get(tx) || {}).account;
  if (exists) return res.status(409).json({ ok: false, error: "呢個 tx 已有人提交過" });
  db.prepare("INSERT INTO deposits(tx_hash,account,sender,amount_usdc,swai,ts,confirmations,processed) VALUES(?,?,?,0,0,?,0,0)")
    .run(tx, u.email, "", Date.now());
  // 拉 tx 資料（Polygon RPC eth_getTransactionReceipt）——approve/清掃可選；MVP：人手確認或者用 rpc
  try {
    await scanPolygonTx(tx, u.email);
  } catch (e) { console.log("[topup] verify deferred:", e.message); }
  const row = db.prepare("SELECT amount_usdc, swai, confirmations, processed FROM deposits WHERE tx_hash=?").get(tx);
  res.json({ ok: true, tx, status: row.processed ? "credited" : "pending", amount_usdc: row.amount_usdc, swai: row.swai });
});

// 掃描 Polygon：攞 tx receipt，睇係咪 USDC Transfer 去 depositWallet
async function scanPolygonTx(tx, account) {
  if (!depositWallet) throw new Error("SWARM_DEPOSIT_WALLET 未設（收款地址）");
  const zh = { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] };
  const r = await fetch(POLYGON_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(zh), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const rec = j.result;
  if (!rec) throw new Error("tx 未確認或唔存在");
  const logs = rec.logs || [];
  const usdcLog = logs.find(l => l.address && l.address.toLowerCase() === USDC_CONTRACT.toLowerCase() && l.topics && l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  if (!usdcLog) throw new Error("唔係 USDC Transfer");
  // topics[1]=from, topics[2]=to（address）
  const to = "0x" + usdcLog.topics[2].slice(26);
  if (to.toLowerCase() !== depositWallet.toLowerCase()) throw new Error("收件地址唔係我哋錢包");
  const amountHex = usdcLog.data;
  const amountUsdc = Number(BigInt("0x" + amountHex) / 1000000n) ;
  const swai = Math.floor(amountUsdc * USDC_TO_SWAI);
  const confirmations = Number(rec.blockNumber || 0);
  db.prepare("UPDATE deposits SET amount_usdc=?, swai=?, sender=?, confirmations=?, processed=? WHERE tx_hash=?")
    .run(amountUsdc, swai, "0x" + usdcLog.topics[1].slice(26), confirmations, amountUsdc >= MIN_USDC_TOPUP ? 1 : 0, tx);
  if (amountUsdc >= MIN_USDC_TOPUP) {
    if (account) {   // 有 account → mint 入帳；冇（純驗證）→ 唔 mint
      ledgerMint(account, { tokensIn: 0, tokensOut: swai * RATE_OUT, taskId: null, note: `topup_${tx.slice(0,8)} ${amountUsdc}usdc`, nodeId: "", kind: "deposit" });
    }
  }
  return { amountUsdc, swai, confirmations };
}

// 公開支付核實（EA 網站用）：只驗證「USDC 有冇轉到收款錢包」；唔使 login、唔 mint account。
// POST /v1/pay/verify {tx} → {ok, amount_usdc, to_wallet_match}
app.post("/v1/pay/verify", async (req, res) => {
  const tx = String((req.body || {}).tx || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return res.status(400).json({ ok: false, error: "tx hash 格式唔啱" });
  try {
    const r = await scanPolygonTx(tx, null);   // account=null → 唔 mint（純驗）
    res.json({ ok: true, tx, amount_usdc: r.amountUsdc, wallet: depositWallet, match: true });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/credits/:account", (req, res) => {
  const acc = req.params.account;
  // 全部屬於呢個 account 嘅 node + 各自 ratio/speed（查詢時明列計法）
  const nodes = [...registry.values()].filter(n => n.account === acc).map(n => ({
    node_id: n.node_id, speed: parseFloat(n.speed) || 0, share_ratio: Math.max(0, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100))), speed_effective: (parseFloat(n.speed) || 0) * (Math.max(0, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100))) / 100),
  }));
  res.json({
    account: acc, balance: creditBalance(acc),
    nodes,
    economy_note: "計法：idle 每分鐘 mint = (tok/s × 60 × share_ratio%) / 1000 SWAI；投票按實際 input/output tokens（in 5000t/SWAI, out 1000t/SWAI）。share_ratio 越低 → idle 賺得越少、派工優先度越低（防蜂擁）。",
  });
});

app.get("/ledger/latest", (req, res) => {
  const limit = Math.min(50, Number(req.query.limit || 20));
  const rows = db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(limit);
  res.json(rows);
});

app.get("/nodes", (_, res) => res.json([...registry.values()]));

// periodic: prune stale + Proof-of-Uptime settlement sweep (10 min)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of pendingBeacons) if (v.ts && v.ts < cutoff) pendingBeacons.delete(k);
  for (const [k, v] of resultsStore) if (v.ts && v.ts < cutoff) resultsStore.delete(k);
  // legacy fallback sweep: 兜返舊 /status 累積嘅 uptime_s（新 /status 已即時 mint idle，呢度補漏）
  for (const n of registry.values()) {
    if (n.uptime_s >= 60 && n.speed) {
      const mins = n.uptime_s / 60;
      const spd = parseFloat(n.speed) || 0;
      const ratio = Math.max(0, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100)));
      const tokens = Math.round(spd * mins * 60 * (ratio / 100));
      const acc = n.account || SYSTEM_ACCOUNT;
      if (tokens > 0) ledgerMint(acc, { tokensIn: 0, tokensOut: tokens, taskId: null, note: "idle_sweep", nodeId: n.node_id, kind: "idle" });
      n.uptime_s -= mins * 60;
    } else if (n.uptime_s >= 60) {
      n.uptime_s = 0; // 無 speed 計唔到, 清咗佢
    }
  }
}, 10 * 60 * 1000).unref();



// ---- Task orchestration (router-centric: push for LAN, pull for NAT nodes) ----
async function doDispatch(list, task_id, payload, inbox, push_ok, fail_ok) {
  // SSRF 防護：router 只會 push（主動 fetch）去「本機 BIND hosts」（平台 workers 都喺 main 上 listen）。
  // 任何其他網段一律 inbox queue（worker 自己 poll）—— 避免外部用戶用 url 令 router 打內網 / 其他 100.x 機器。
  for (const { node } of list) {
    const urlSafe = nodePushAddrOK(node.url);
    const assignBody = { ...payload, auth: signAssign(payload.task_id, node.node_id), ts: Date.now() };
    try {
      if (node.pull || !urlSafe) {
        const q = inbox.get(node.node_id) || [];
        q.push(assignBody);
        inbox.set(node.node_id, q);
        push_ok && push_ok({ node_id: node.node_id, pull: true });
      } else {
        await fetch(`${node.url}/assign`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(assignBody), signal: AbortSignal.timeout(60000) });
        push_ok && push_ok({ node_id: node.node_id, pull: false });
      }
    } catch (e) {
      fail_ok && fail_ok({ node_id: node.node_id, error: e.message });
    }
  }
}
// SSRF 閘：push 只允許去本機 BIND hosts（平台 worker listeners）；其他一律 inbox
function nodePushAddrOK(u) {
  try {
    const host = new URL(u || "").hostname;
    return BIND.some(b => b === host);   // 127.0.0.1 / 100.70.76.100（main 自己）
  } catch (e) { return false; }
}

app.post("/task", async (req, res) => {
  const { beacon_id, prompt, required_capabilities = ["reasoning"], n_votes = 3, temperature = 0.6 } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: "prompt required" });
  const MAX_PROMPT = Number(process.env.SWARM_MAX_PROMPT || 8000);
  if (prompt.length > MAX_PROMPT) return res.status(413).json({ ok: false, error: "prompt 太長" });
  const bid = beacon_id || crypto.randomUUID();
  const task_id = crypto.randomUUID();
  const reqTok = req.get("x-swarm-token");
  const tOk = reqTok ? accountForToken(reqTok) : null;
  const matches = matchCapabilities(required_capabilities, [...registry.values()], tOk);
  const pushed = [], queued = [], failed = [];
  const payload = { task_id, beacon_id: bid, prompt, n_votes, temperature };
  resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: 0, est_tokens_in: 0, est_tokens_out: 0 });

  // 自動扣費 v2：按 tokens 預估。input = prompt 字數估算; output = n_votes × n_predict 上限（保守）
  // 自己機優先：全部自己機 → 唔 burn；部分出面 → 照收；balance 唔夠 → fallback 落自己機+free node
  const EST_CHARS_PER_TOKEN = 3.5;
  let dispatchList = matches.slice(0, (req.body.max_targets || CONFIG.max_beacon_targets || 5));
  const selfNodes = dispatchList.filter(m => tOk && m.node.account === tOk);
  const externalNodes = dispatchList.filter(m => !tOk || m.node.account !== tOk);
  const freeNodes = dispatchList.filter(m => m.node.free || (m.node.account === tOk));
  // 自己機優先：pref != fastest 且有自己機上線 → 只派自己機（佢唔夠用先落到出面）
  // pref=free-first：自己機好缺時，free node 都一併優先（唔扣 token）
  const pref = dispatchPrefFor(tOk);
  if (tOk && pref === "free-first") {
    const awsNodes = matches.slice(0, (req.body.max_targets || CONFIG.max_beacon_targets || 5));
    const fl = awsNodes.filter(m => m.node.account === tOk || m.node.free);
    if (fl.length) dispatchList = fl;
  } else if (tOk && pref !== "fastest" && selfNodes.length) {
    dispatchList = selfNodes;
  }
  const allSelf = dispatchList.length > 0 && selfNodes.length === dispatchList.length;
  const hasAnyFallback = freeNodes.length > 0;       // token 唔夠時可用嘅免費通道
  let dispatchMode = "self";                          // self | paid | fallback
  let promoUsed = null;
  const estIn = Math.round(prompt.length / EST_CHARS_PER_TOKEN);
  const estOut = n_votes * 512;
  let fee = tokensToCredit(estIn, estOut);
  if (tOk && reqTok !== NET_TOKEN && !allSelf) {
    const promoCode = promoFromReq(req);
    if (promoCode) { const r = applyPromoToFee(promoCode, fee); fee = r.fee; promoUsed = r.promo; }
    const bal = creditBalance(tOk);
    if (bal < fee) {
      // 唔夠 token → 睇有冇自己機/free machine 兜底 → fallback（免費照做）；冇 → 402
      if (hasAnyFallback) {
        dispatchMode = "fallback";
        const fallbackList = matches.slice(0, (req.body.max_targets || CONFIG.max_beacon_targets || 5))
          .filter(m => m.node.free || (tOk && m.node.account === tOk));
        resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: 0, est_tokens_in: estIn, est_tokens_out: estOut, fallback: true, assigned: new Set(fallbackList.map(x => x.node.node_id)) });
        await doDispatch(fallbackList, task_id, payload, inbox, x => queued.push(x), x => failed.push(x));
        return res.json({ ok: true, task_id, beacon_id: bid, mode: "fallback", notice: "SWAI 唔夠 → 已自動落返自己機 / free machine（免費）", pushed, queued, failed, promo_used: null });
      }
      return res.status(402).json({ ok: false, error: "SWAI 餘額不足，唔夠出 task", balance: bal, fee, est_tokens_in: estIn, est_tokens_out: estOut });
    }
    const qRem = dailyQuotaRemaining(tOk);
    if (fee > qRem) {
      if (hasAnyFallback) {
        dispatchMode = "fallback";
        const fallbackList = matches.slice(0, (req.body.max_targets || CONFIG.max_beacon_targets || 5))
          .filter(m => m.node.free || (tOk && m.node.account === tOk));
        resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: 0, est_tokens_in: estIn, est_tokens_out: estOut, fallback: true, assigned: new Set(fallbackList.map(x => x.node.node_id)) });
        await doDispatch(fallbackList, task_id, payload, inbox, x => queued.push(x), x => failed.push(x));
        return res.json({ ok: true, task_id, beacon_id: bid, mode: "fallback", notice: `今日 quota 到頂 → 已自動落返自己機 / free machine（每日上限 ${DAILY_BURN_CAP}）`, pushed, queued, failed, promo_used: null });
      }
      return res.status(429).json({ ok: false, error: `今日 burn 上限已到 / 剩餘唔夠（每日上限 ${DAILY_BURN_CAP} SWAI，今日剩 ${qRem}）`, daily_cap: DAILY_BURN_CAP, daily_remaining: qRem, need: fee });
    }
    ledgerBurnChecked(tOk, fee, task_id, "task_estimate");
    dispatchMode = externalNodes.length ? "paid" : "self";
  } else {
    dispatchMode = dispatchList.length ? (allSelf ? "self" : "self") : dispatchMode;
  }
  await doDispatch(dispatchList, task_id, payload, inbox, x => pushed.push(x), x => failed.push(x));
  res.json({ ok: true, task_id, beacon_id: bid, mode: dispatchMode, pushed, queued, failed, promo_used: promoUsed });
});

app.get("/results/:task_id", (req, res) => {
  const rec = resultsStore.get(req.params.task_id);
  res.json({ task_id: req.params.task_id, done: rec ? rec.list.length : 0, results: rec ? rec.list : [] });
});

// ---- OpenAI-compatible gateway ----
app.get("/v1/models", (req, res) => {
  const list = Object.entries(MODEL_MAP).filter(([, m]) => !m.hidden).map(([id, m]) => ({
    id, object: "model", created: Math.floor(Date.now() / 1000),
    owned_by: "swarmai", description: m.label,
    swarmai: { n_votes: m.n_votes, tiers: m.tier },
  }));
  res.json({ object: "list", data: list });
});

function detectImageInMessages(messages) {
  for (const msg of messages || []) {
    const c = msg.content;
    if (typeof c === "string") { if (/data:image\/(png|jpeg|webp|gif);base64,/.test(c)) return true; continue; }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && (part.type === "image_url" || part.image_url)) return true;
        if (part && part.type === "text" && /data:image\//.test(part.text || "")) return true;
      }
    }
  }
  return false;
}
function extractImagesFromMessages(messages, maxBytes = 4 * 1024 * 1024) {
  // 抽返 base64 image → [{data, media_type}]（限制 size 防 DoS）
  const imgs = [];
  for (const msg of messages || []) {
    const c = msg.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && (part.type === "image_url" || part.image_url)) {
          let url = part.image_url?.url || part.url || "";
          const m = url.match(/^data:(image\/\w+);base64,([A-Za-z0-9+/=]+)$/);
          if (m && m[2].length <= maxBytes * 1.34) imgs.push({ data: m[2], media_type: m[1] });
        } else if (part && part.type === "text") {
          const m = (part.text || "").match(/data:(image\/\w+);base64,([A-Za-z0-9+/=]+)/);
          if (m && m[2].length <= maxBytes * 1.34) imgs.push({ data: m[2], media_type: m[1] });
        }
      }
    }
  }
  return imgs;
}
function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages || []) {
    const role = msg.role || "user";
    const c = msg.content;
    if (typeof c === "string") {
      parts.push((role === "system" ? "SYSTEM: " : "USER: ") + c);
    } else if (Array.isArray(c)) {
      const texts = c.filter(p => p.type !== "image_url" && !p.image_url).map(p => p.text || "").join("\n");
      if (texts) parts.push((role === "system" ? "SYSTEM: " : "USER: ") + texts);
    }
  }
  return parts.join("\n\n");
}
// 判斷呢個 request 係咪 agentic/tool-call 類：有 tools schema 或 conversation 已經帶 tool 回合
function isToolRequest(messages, tools) {
  if (Array.isArray(tools) && tools.length) return true;
  for (const m of messages || []) {
    if (m.role === "tool" || m.role === "function" || Array.isArray(m.tool_calls)) return true;
  }
  return false;
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model = "swarmai-normal", messages = [], temperature = 0.6, max_tokens = 512, stream = false, tools, tool_choice, stop } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: { message: "messages required" }, type: "invalid_request_error" });
    const reqTok = req.get("x-swarm-token") || (req.swarmToken || "");
    const hasImage = detectImageInMessages(messages);
    const useTool = isToolRequest(messages, tools);
    const modelKey = hasImage ? "swarmai-vision" : (MODEL_MAP[model] ? model : "swarmai-normal");
    const mm = MODEL_MAP[modelKey];
    const prompt = useTool ? "" : messagesToPrompt(messages);
    const images = hasImage ? extractImagesFromMessages(messages) : [];
    // context 防護：估算 prompt tokens，對比網絡內 node 最細可用 ctx（保守）
    const estPromptTokens = Math.round(prompt.length / 3.5) + (images.length ? 1024 * images.length : 0);
    const ctxOptions = [...registry.values()].filter(n => n.account && n.max_context > 0).map(n => n.max_context);
    const minCtx = ctxOptions.length ? Math.min(...ctxOptions) : 8192;
    if (!useTool && estPromptTokens > minCtx) {
      return res.status(413).json({ error: { message: `prompt 太大（~${estPromptTokens} tokens，網絡上限 ${minCtx}）——建議開新 context/縮短對話`, type: "context_length_exceeded" }, type: "context_length_exceeded" });
    }
    const topTier = mm.tier && mm.tier.length ? mm.tier[0] : "B";

    // tier 收費：fast 用 node tier 較高（如 S/A）→ 貴；normal → 平。選 max tier 計費（保守）
    // free node：targets 全 free → 要求者唔 burn（善意分享）；mixed/付費 → 正常收
    let estFee = 0;
    let freeServed = false;

    // 派工：揀符合 modelKey tier + cap 嘅 node
    //  freeOnly → 只揀 free node；其他 model（fast/normal）免費 node 都入選（高 grade 優先）
    //  tool request → 只揀 abilities.tools === true 嘅 node（真工具支援，唔好派去 text-only）
    const wantedTiers = mm.tier;
    let candidates = [...registry.values()].filter(n => n.account && (mm.freeOnly ? n.free : (wantedTiers.includes(nodeTier(n)) || n.free)) && (!useTool || (n.abilities && n.abilities.tools === true)));
    console.log(`[v1] model=${modelKey} tool=${useTool} stream=${stream} caps=${JSON.stringify(mm.cap)} tier=${JSON.stringify(mm.tier)} reg=${registry.size} cand=${candidates.map(c=>c.node_id+":"+nodeTier(c)+(c.free?"(F)":""))}`)
    if (!candidates.length && !mm.freeOnly) {
      candidates = [...registry.values()].filter(n => n.account); // fallback 平價
      console.log(`[v1] fallback all-candidates=${candidates.map(c=>c.node_id).join(",")}`);
    }
    // 排序：score（含 rating/grade × share_ratio ＋ 自己機優先加分）為主，speed 只做 tiebreak
    const reqAcc = reqTok ? accountForToken(reqTok) : null;
    const sorted = matchCapabilities(mm.cap, candidates, reqAcc).sort((a,b) =>
      b.score - a.score || (parseFloat(b.node.speed)||0) - (parseFloat(a.node.speed)||0));
    console.log(`[v1] sorted=${sorted.map(s=>s.node.node_id+":"+s.score.toFixed(2)).join(",")}`);
    // tool request 唔適合投票聚合（每個 node 會各自回唔同 tool call）→ 只派單一最佳 node
    const nTargets = useTool ? 1 : Math.max(1, mm.n_votes);
    let targets = sorted.slice(0, nTargets).map(x => x.node);
    // 自己機優先：pref != fastest 且有自己機 → 只派自己機
    const _pref = dispatchPrefFor(reqAcc);
    if (reqAcc && _pref === "free-first") {
      const fl = sorted.map(s => s.node).filter(t => t.account === reqAcc || t.free).slice(0, nTargets);
      if (fl.length) targets = fl;
    } else if (reqAcc && _pref !== "fastest") {
      const own = sorted.map(s => s.node).filter(t => t.account === reqAcc).slice(0, nTargets);
      if (own.length) targets = own;
    }
    if (!targets.length) {
      return res.status(503).json({ error: { message: "no available worker" }, type: "server_error" });
    }
    // 收費決定：
    //  - 全部自己機 → self（唔 burn）
    //  - 有 free node 參與（或 freeOnly model）→ free（唔 burn）
    //  - balance/quota 唔夠 → fallback 落自己機+free node；真冇先 402/429
    let dispatchMode = "self";
    const selfCandidates = targets.filter(t => reqAcc && t.account === reqAcc);
    const allSelf = targets.length > 0 && selfCandidates.length === targets.length;
    freeServed = mm.freeOnly || targets.some(t => t.free);
    let promoUsed = null;
    const estIn = Math.round((prompt.length || 1000) / 3.5);
    const estOut = max_tokens;
    if (reqAcc && reqTok !== NET_TOKEN && !freeServed && !allSelf) {
      estFee = tokensToCredit(estIn, estOut, tierCharge(topTier));
      const promoCode = promoFromReq(req);
      if (promoCode) { const r = applyPromoToFee(promoCode, estFee); estFee = r.fee; promoUsed = r.promo; }
      const bal = creditBalance(reqAcc);
      const fallbackTargets = sorted.map(s => s.node).filter(t => t.free || (t.account === reqAcc)).slice(0, 1);
      if (bal < estFee) {
        if (fallbackTargets.length) {
          dispatchMode = "fallback";
          targets.length = 0; targets.push(...fallbackTargets);
          estFee = 0;
          console.log(`[v1] fallback-self ${targets.map(t=>t.node_id).join(",")}`);
        } else {
          return res.status(402).json({ error: { message: `SWAI 餘額不足 (balance ${bal}, need ${estFee})`, type: "insufficient_balance" } });
        }
      } else {
        const qRem = dailyQuotaRemaining(reqAcc);
        if (estFee > qRem) {
          if (fallbackTargets.length) {
            dispatchMode = "fallback";
            targets.length = 0; targets.push(...fallbackTargets);
            estFee = 0;
          } else {
            return res.status(429).json({ error: { message: `今日 burn 上限已到（每日上限 ${DAILY_BURN_CAP} SWAI，今日剩 ${qRem}）`, type: "daily_quota_exceeded" }, error_type: "daily_quota_exceeded", daily_cap: DAILY_BURN_CAP, daily_remaining: qRem });
          }
        } else {
          ledgerBurnChecked(reqAcc, estFee, null, "v1_chat_estimate");
          dispatchMode = allSelf ? "self" : "paid";
        }
      }
    } else {
      dispatchMode = allSelf ? "self" : (mm.freeOnly || freeServed ? "free" : "self");
    }
    const task_id = crypto.randomUUID();
    const beacon_id = crypto.randomUUID();
    const payload = {
      task_id, beacon_id, prompt, n_votes: nTargets, temperature,
      image_data: images.length ? images : undefined,
      max_tokens, stop: stop || undefined,
    };
    if (useTool) {
      // 工具模式：保留原始 messages（含 tool 回合）+ tools schema 原樣派工
      payload.chat_messages = messages;
      if (Array.isArray(tools) && tools.length) payload.tools = tools;
      if (tool_choice) payload.tool_choice = tool_choice;
    }
    resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: estFee, est_tokens_in: Math.round((prompt.length || 1000)/3.5), est_tokens_out: max_tokens, assigned: new Set(targets.map(t=>t.node_id)) });
    const p = [];
    console.log(`[v1] targets=${targets.map(t=>t.node_id).join(",")} n_votes=${nTargets} tool=${useTool}`);
    for (const node of targets) {
      try {
        const assignBody = { ...payload, auth: signAssign(payload.task_id, node.node_id) };
        if (node.pull || !nodePushAddrOK(node.url)) {   // SSRF 防護：非本機 BIND hosts 一律 inbox
          const q = inbox.get(node.node_id) || []; q.push(assignBody); inbox.set(node.node_id, q);
        } else {
          await fetch(`${node.url}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(assignBody), signal: AbortSignal.timeout(90000) });
        }
        p.push(node.node_id);
      } catch (e) { /* 單一等 */ }
    }
    // 等結果：快返（≥1 result 即出，唔等齊）；上限 25s（OpenAI 兼容要 reasonable latency）
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const cur = resultsStore.get(task_id);
      if (cur && cur.list && cur.list.length >= 1) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const rec = resultsStore.get(task_id);

    let winner = null, conf = 0, toolCalls = null, finishReason = "length";
    if (useTool) {
      // tool 模式：取第一個帶 tool_calls 嘅 vote；冇則 fallback 文字
      for (const r of (rec?.list || [])) {
        for (const v of (r.votes || [])) {
          if (Array.isArray(v.tool_calls) && v.tool_calls.length) {
            toolCalls = v.tool_calls; winner = v.content || ""; finishReason = "tool_calls";
            conf = Math.max(conf, Number(v.confidence) || 0.5);
            break;
          }
        }
        if (toolCalls) break;
      }
      if (!toolCalls) {
        for (const r of (rec?.list || [])) for (const v of (r.votes || [])) {
          const ans = String(v.content || "").trim();
          if (ans) { winner = ans; conf = Math.max(conf, Number(v.confidence) || 0.5); finishReason = v.finish_reason || "stop"; }
        }
      }
    } else {
      // 傳統 text 投票聚合
      const tally = {};
      for (const r of (rec?.list || [])) for (const v of (r.votes || [])) {
        const ans = String(v.content || "").trim(); tally[ans] = (tally[ans] || 0) + (v.confidence || 0.5);
      }
      const [w, c] = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0] || [null, 0];
      winner = w; conf = c; finishReason = winner ? (stop ? "stop" : "stop") : "length";
    }
    // 精算：實際 tokens → 多退
    const tin = (rec?.list || []).reduce((s,r)=>s+(r.tokens_in||0),0);
    const tout = (rec?.list || []).reduce((s,r)=>s+(r.tokens_out||0),0);
    if (reqAcc && reqTok !== NET_TOKEN && estFee > 0) {
      const actual = tokensToCredit(tin, tout, tierCharge(topTier));
      if (estFee > actual) { const d = estFee - actual; ledgerMint(reqAcc, { tokensIn: 0, tokensOut: Math.round(d * RATE_OUT), taskId: task_id, note: "v1_refund", nodeId: reqAcc, kind: "refund" }); }
    }

    const message = { role: "assistant", content: winner || "" };
    if (toolCalls) message.tool_calls = toolCalls;
    const bodyObj = {
      id: task_id, object: "chat.completion", created: Math.floor(Date.now()/1000), model: modelKey,
      choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : winner ? (finishReason || "stop") : "length" }],
      usage: { prompt_tokens: Math.round((prompt.length || 1000)/3.5), completion_tokens: tout, total_tokens: Math.round((prompt.length || 1000)/3.5) + tout },
      swarmai: { nodes: p, votes: (rec?.list || []).map(r => r.node_id), confidence: Number(conf.toFixed(3)), est_fee: estFee, free_served: freeServed, promo_used: promoUsed, image_routed: hasImage, mode: dispatchMode, notice: dispatchMode === "fallback" ? "SWAI 唔夠 / quota 到頂 → 已自動落返自己機 + free machine（免費）" : undefined },
    };
    if (!stream) return res.json(bodyObj);

    // ---- SSE streaming（OpenAI protocol：delta chunks + finish_reason + [DONE]）
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const created = Math.floor(Date.now()/1000);
    const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: task_id, object: "chat.completion.chunk", created, model: modelKey };
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    if (toolCalls) {
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
    } else if (winner) {
      chunk({ ...base, choices: [{ index: 0, delta: { content: winner }, finish_reason: null }] });
    }
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : winner ? "stop" : "length" }] });
    chunk({ ...base, choices: [], usage: { prompt_tokens: Math.round((prompt.length || 1000)/3.5), completion_tokens: tout, total_tokens: Math.round((prompt.length || 1000)/3.5) + tout } });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    res.status(500).json({ error: { message: String(e.message || e).slice(0, 200) }, type: "server_error" });
  }
});

// ---- Specialty gateway: 圖像生成（SD-WebUI/ComfyUI 等 image-gen worker）----
app.post("/v1/images/generations", async (req, res) => {
  try {
    const { model = "swarmai-image", prompt = "", n = 1, size = "512", response_format = "b64_json" } = req.body || {};
    if (!prompt) return res.status(400).json({ error: { message: "prompt required" }, type: "invalid_request_error" });
    const mm = MODEL_MAP[model] || MODEL_MAP["swarmai-image"];
    if (!mm.unit) return res.status(400).json({ error: { message: `model ${model} 唔係影像生成`, type: "invalid_request_error" } });
    const units = Math.max(1, Math.min(mm.max_units || 4, Number(n) || 1));
    const reqTok = req.get("x-swarm-token") || (req.swarmToken || "");
    const reqAcc = reqTok ? accountForToken(reqTok) : null;
    const fee = specialtyFee(units, mm.unitPrice);
    let freeServed = false;
    // 派工：只揀有 image-gen cap 嘅 node
    let candidates = [...registry.values()].filter(n => n.account && (n.capabilities || []).includes("image-gen"));
    console.log(`[img] model=${model} units=${units} cand=${candidates.map(c=>c.node_id).join(",")}`);
    // free node 只係可選 bonus；唔做 freeOnly——image 要收費（成本唔細）
    if (!candidates.length) return res.status(503).json({ error: { message: "no image worker available（未有 image-gen node）", type: "server_error" } });
    const sorted = matchCapabilities(mm.cap, candidates, reqAcc).sort((a,b) => b.score - a.score);
    let target = sorted[0].node;
    let estFee = 0, promoUsed = null;
    let dispatchMode = "paid";
    if (reqAcc && reqTok !== NET_TOKEN && !(target.account === reqAcc) && !target.free) {
      estFee = fee;
      const promoCode = promoFromReq(req);
      if (promoCode) { const r2 = applyPromoToFee(promoCode, estFee); estFee = r2.fee; promoUsed = r2.promo; }
      const bal = creditBalance(reqAcc);
      const hasSelfGen = sorted.some(x => x.node.account === reqAcc || x.node.free);
      if (bal < estFee) {
        if (hasSelfGen) {  // 自己 image-gen or free → fallback 免費
          const fb = sorted.find(x => x.node.account === reqAcc || x.node.free);
          estFee = 0; dispatchMode = "fallback";
          sorted.length = 0; sorted.push({ node: fb.node, score: 1 });
        } else {
          return res.status(402).json({ error: { message: `SWAI 餘額不足 (balance ${bal}, need ${estFee})` }, type: "insufficient_balance" });
        }
      } else {
        const qRem = dailyQuotaRemaining(reqAcc);
        if (estFee > qRem) {
          if (hasSelfGen) { const fb = sorted.find(x => x.node.account === reqAcc || x.node.free); estFee = 0; dispatchMode = "fallback"; sorted.length = 0; sorted.push({ node: fb.node, score: 1 }); }
          else return res.status(429).json({ error: { message: `今日 burn 上限已到（每日上限 ${DAILY_BURN_CAP} SWAI，今日剩 ${qRem}）`, type: "daily_quota_exceeded" }, daily_cap: DAILY_BURN_CAP, daily_remaining: qRem });
        } else { ledgerBurnChecked(reqAcc, estFee, "img_" + Date.now(), "image_estimate"); dispatchMode = target.account === reqAcc ? "self" : "paid"; }
      }
    } else if (target.account === reqAcc) { dispatchMode = "self"; }
    const task_id = crypto.randomUUID();
    target = sorted[0].node;   // 可能係 fallback 後嘅 node
    const payload = {
      task_id, "adapter": "image", prompt, n: units, size,
      image_data: undefined, max_tokens: 0,
    };
    resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: estFee, units, unit_price: mm.unitPrice, assigned: new Set([target.node_id]) });
    try {
      const assignBody = { ...payload, auth: signAssign(task_id, target.node_id) };
      if (target.pull || !nodePushAddrOK(target.url)) { const q = inbox.get(target.node_id) || []; q.push(assignBody); inbox.set(target.node_id, q); }
      else await fetch(`${target.url}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(assignBody), signal: AbortSignal.timeout(180000) });
    } catch (e) {
      return res.status(500).json({ error: { message: `image worker 派工失敗：${e.message}`, type: "server_error" } });
    }
    // 等結果（最多 180s）
    const deadline = Date.now() + 180000;
    let rec = resultsStore.get(task_id);
    while (Date.now() < deadline) {
      rec = resultsStore.get(task_id);
      if (rec && rec.list.length) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    rec = resultsStore.get(task_id);
    const actualImgs = (rec?.list || []).flatMap(r => (r.images || []));
    const images = actualImgs.map(img => ({ b64_json: String(img).replace(/^data:image\/\w+;base64,/, "") }));
    if (!images.length) return res.status(500).json({ error: { message: "image worker 超時/無結果", type: "server_error" } });
    const mints = [];
    for (const r of (rec?.list || [])) {
      const acc = (r._account) || (registry.get(r.node_id)?.account) || SYSTEM_ACCOUNT;
      if (r.node_id) { const c = ledgerMint(acc, { units: actualImgs.length || 1, unitPrice: mm.unitPrice, taskId: task_id, note: "image_gen", nodeId: r.node_id, kind: "image" }); mints.push({ node_id: r.node_id, credit: c }); }
    }
    res.json({
      created: Math.floor(Date.now()/1000), data: images, model,
      usage: { image_count: images.length },
      swarmai: { nodes: (rec.list || []).map(r => r.node_id), est_fee: estFee, free_served: freeServed, promo_used: promoUsed, mode: dispatchMode, notice: dispatchMode === "fallback" ? "SWAI 唔夠 / quota 到頂 → 已自動落返自己機 + free machine（免費）" : undefined },
    });
  } catch (e) {
    res.status(500).json({ error: { message: String(e.message || e).slice(0, 200) }, type: "server_error" });
  }
});

app.get("/tasks/poll", (req, res) => {
  const { node_id } = req.query;
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  // P2 鎖 node：poll 嘅 token 必須屬於該 node 嘅 account（防偷人 inbox）
  const t = req.get("x-swarm-token") || (req.swarmToken || "");
  const acc = accountForToken(t);
  const node = registry.get(String(node_id));
  if (node && node.account && acc && node.account !== acc) {
    return res.status(403).json({ ok: false, error: "唔係你嘅 node" });
  }
  const q = inbox.get(String(node_id)) || [];
  if (q.length) inbox.set(String(node_id), []);
  res.json({ ok: true, tasks: q });
});

// ---- Client portal (login -> token -> SWAI balance) ----
app.post("/portal/signup", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "email + password required" });
  const pw = String(password);
  if (pw.length < 13) return res.status(400).json({ ok: false, error: "密碼至少 13 位" });
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw))
    return res.status(400).json({ ok: false, error: "密碼要同時有大階+細階+數字+符號" });
  const e = String(email).toLowerCase();
  if (userByEmail(e)) return res.status(409).json({ ok: false, error: "email already registered" });
  const token = mkToken();
  const node_id = mkNodeId(e);
  db.prepare("INSERT INTO users(email,pass_hash,token,node_id,created) VALUES(?,?,?,?,?)")
    .run(e, hashPass(password), token, node_id, Date.now());
  db.prepare("INSERT INTO user_keys(email, token, label, created, scope) VALUES(?,?,?,?,?)")
    .run(e, token, "primary", Date.now(), "full");
  claimNode(node_id, e);
  ensureDepositAddr(e);
  console.log(`[signup] ${e} -> ${node_id} (ip ${req.connection?.remoteAddress || ''})`);
  // Pilot 開戶送分（試玩額）
  if (SIGNUP_BONUS > 0) {
    ledgerMint(e, { tokensIn: 0, tokensOut: SIGNUP_BONUS * RATE_OUT, taskId: null, note: "welcome_bonus", nodeId: node_id, kind: "manual" });
  }
  res.json({ ok: true, email: e, api_token: token, node_id, welcome_bonus: SIGNUP_BONUS });
});

app.post("/portal/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = userByEmail(email);
  if (!u || u.pass_hash !== hashPass(password)) return res.status(401).json({ ok: false, error: "bad credentials" });
  res.json({ ok: true, email: u.email, api_token: u.token, node_id: u.node_id, balance: creditBalance(u.email) });
});

app.get("/portal/me", (req, res) => {
  const t = req.get("x-swarm-token");
  const u = findUserByToken(t);
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const led = db.prepare("SELECT * FROM ledger WHERE account=? ORDER BY id DESC LIMIT 20").all(u.email);
  const nodes = [...registry.values()].filter(n => n.account === u.email).map(n => {
    const st = nodeSetting(n.node_id);
    return {
      node_id: n.node_id, speed: parseFloat(n.speed) || 0, share_ratio: Math.max(0, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100))),
      tier: nodeTier(n), ctx: n.max_context || 0, model: n.model || "", gpu: n.gpu || "", free: !!n.free,
      abilities: n.abilities || null,
      rating: computeRating(n),
      online: nodeOnline(n),
      last_seen_min: nodeLastSeenMin(n),
      settings: {
        free: !!st.free,
        sleep_start_hour: st.sleep_start_hour ?? null,
        sleep_end_hour: st.sleep_end_hour ?? null,
        share_ratio: st.share_ratio ?? null,
        suspend: !!st.suspend,
        removed: !!st.removed,
      },
    };
  });
  const prof = db.prepare("SELECT display_name, pref_model, timezone, sleep_start_hour, sleep_end_hour, share_default, max_budget_per_task, dispatch_pref FROM users WHERE email=?").get(u.email) || {};
  const myOnline = nodes.filter(n => n.online && !n.settings.removed).length;
  const bal = creditBalance(u.email);
  const dispatchMode = bal <= 0 ? (myOnline ? "fallback" : "empty") : (myOnline ? "self" : "paid");
  res.json({
    ok: true, email: u.email, node_id: u.node_id, account: u.email, balance: bal,
    dispatch: { pref: prof.dispatch_pref || "self", mode: dispatchMode, notice: dispatchMode === "fallback" ? "SWAI 有限 → 而家自動用緊你自己機（唔扣 token；想用出面機就去充值）" : (dispatchMode === "empty" ? "SWAI 用完，自己機又冇上線 → 請充值或起返自己 worker" : (myOnline ? "自己機優先（免費）；可用出面機時先至扣 SWAI" : "出面機主導（按 rating 揀）——想優先自己機？起返自己 worker 即刻免費")) },
    profile: prof,
    keys: listKeysByToken(t).map(k => ({ token: k.token, label: k.label, scope: k.scope || "full", last_used_at: k.last_used_at, last_ip: k.last_ip })),
    daily: { cap: DAILY_BURN_CAP, used: dailyUsed(u.email), remaining: dailyQuotaRemaining(u.email) },
    topup: { min_usdc: MIN_USDC_TOPUP, rate: USDC_TO_SWAI, deposit_addr: (db.prepare("SELECT usdc_deposit_addr FROM users WHERE email=?").get(u.email) || {}).usdc_deposit_addr || null },
    nodes,
    economy_note: "計法：idle 1 分鐘 mint = (tok/s × 60 × share_ratio%) / 1000 SWAI；投票按實際 in/out tokens（in 5000t/SWAI、out 1000t/SWAI）。share_ratio=100 全產能；越低越少誘獎、派工優先度越低（防蜂擁）。充值：1 USDC = " + USDC_TO_SWAI + " SWAI。",
    journal: led
  });
});

// 用戶可更新嘅 profile 欄位
app.post("/portal/update_profile", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const b = req.body || {};
  const fields = {};
  if (b.display_name !== undefined) fields.display_name = String(b.display_name).slice(0, 40);
  if (b.pref_model !== undefined && ["swarmai-fast", "swarmai-normal"].includes(b.pref_model)) fields.pref_model = b.pref_model;
  if (b.timezone !== undefined) fields.timezone = String(b.timezone).slice(0, 40);
  if (b.sleep_start_hour !== undefined) fields.sleep_start_hour = Math.max(0, Math.min(23, Number(b.sleep_start_hour) || 0));
  if (b.sleep_end_hour !== undefined) fields.sleep_end_hour = Math.max(0, Math.min(23, Number(b.sleep_end_hour) || 7));
  if (b.share_default !== undefined) fields.share_default = Math.max(0, Math.min(100, Number(b.share_default) || 100));
  if (b.max_budget_per_task !== undefined) fields.max_budget_per_task = Math.max(0, Number(b.max_budget_per_task) || 0);
  if (b.dispatch_pref !== undefined && ["self", "fastest", "free-first"].includes(b.dispatch_pref)) fields.dispatch_pref = b.dispatch_pref;
  if (!Object.keys(fields).length) return res.status(400).json({ ok: false, error: "no fields" });
  const sets = Object.keys(fields).map(k => `${k}=?`).join(",");
  db.prepare(`UPDATE users SET ${sets} WHERE email=?`).run(...Object.values(fields), u.email);
  res.json({ ok: true, profile: fields });
});

// owner 可開關每個 node 嘅 free（per-node free setting）
app.post("/portal/node_toggle", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const { node_id, free } = req.body || {};
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  const n = registry.get(String(node_id));
  if (!n) return res.status(404).json({ ok: false, error: "node 唔存在" });
  if (n.account !== u.email) return res.status(403).json({ ok: false, error: "唔係你嘅 node" });
  n.free = !!free;
  n.free_manual = true;   // owner 設定優先，心跳唔覆寫
  db.prepare("INSERT INTO node_settings(node_id,email,free,updated) VALUES(?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET free=?, updated=?")
    .run(String(node_id), u.email, n.free ? 1 : 0, Date.now(), n.free ? 1 : 0, Date.now());
  res.json({ ok: true, node_id, free: n.free });
});

// per-node 設定：sleep 窗口 / share_ratio / suspend（node 級覆寫 user 預設；冇填 = 跟 user 預設）
app.post("/portal/node_settings", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const { node_id } = req.body || {};
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  const n = registry.get(String(node_id));
  if (!n) return res.status(404).json({ ok: false, error: "node 唔存在" });
  if (n.account !== u.email) return res.status(403).json({ ok: false, error: "唔係你嘅 node" });
  const b = req.body || {};
  const cols = [];
  const vals = [];
  if (b.sleep_start_hour !== undefined && b.sleep_start_hour !== null && b.sleep_start_hour !== "") { cols.push("sleep_start_hour"); vals.push(Math.max(0, Math.min(23, Number(b.sleep_start_hour) || 0))); }
  if (b.sleep_end_hour !== undefined && b.sleep_end_hour !== null && b.sleep_end_hour !== "") { cols.push("sleep_end_hour"); vals.push(Math.max(0, Math.min(23, Number(b.sleep_end_hour) || 0))); }
  if (b.share_ratio !== undefined && b.share_ratio !== null && b.share_ratio !== "") { cols.push("share_ratio"); vals.push(Math.max(0, Math.min(100, Number(b.share_ratio) || 0))); }
  if (b.suspend !== undefined) { cols.push("suspend"); vals.push(b.suspend ? 1 : 0); }
  if (b.free !== undefined) { cols.push("free"); vals.push(b.free ? 1 : 0); }
  if (!cols.length) return res.status(400).json({ ok: false, error: "no fields" });
  db.prepare(`INSERT OR IGNORE INTO node_settings(node_id,email,updated) VALUES(?,?,?)`).run(String(node_id), u.email, Date.now());
  const sets = cols.map(c => `${c}=?`).join(",");
  db.prepare(`UPDATE node_settings SET ${sets}, updated=? WHERE node_id=?`).run(...vals, Date.now(), String(node_id));
  const out = { node_id };
  cols.forEach((c, i) => out[c] = vals[i]);
  if (b.share_ratio !== undefined && b.share_ratio !== null && b.share_ratio !== "") n.share_ratio = Number(b.share_ratio);
  if (b.free !== undefined) { n.free = !!b.free; n.free_manual = true; }
  res.json({ ok: true, settings: out });
});

// 移除 node（換機/重裝/唔要部機）：從 registry 移除 + 標記 removed（心跳唔再復活）。
// 想「重設」= 移除後再 register（新機照裝同 node_id 就自動 re-enable）。portability: 移除唔釋放 node_owners，
// 因為 node_id 係你 email 派生，唔俾人偷；重新裝返同樣 BIND 返。
app.post("/portal/node_remove", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const node_id = String((req.body || {}).node_id || "");
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  const n = registry.get(node_id);
  const isOwner = (n && n.account === u.email) || (nodeOwner(node_id) || {}).account === u.email;
  if (!isOwner) return res.status(403).json({ ok: false, error: "唔係你嘅 node" });
  registry.delete(node_id);
  db.prepare("INSERT INTO node_settings(node_id,email,removed,updated) VALUES(?,?,1,?) ON CONFLICT(node_id) DO UPDATE SET removed=1, updated=?")
    .run(node_id, u.email, Date.now(), Date.now());
  console.log(`[node_remove] ${u.email} removed ${node_id}`);
  res.json({ ok: true, node_id, removed: true, hint: "重新裝返同一 node_id 就會自動啟用；想用新機新名 → 裝新 worker 用新 --node-id" });
});

// Admin 專用清理（NET_TOKEN only）—— 俾 smoke test / 監察清走測試 node
app.post("/admin/node_remove", (req, res) => {
  const tk = req.get("x-swarm-token");
  if (tk !== NET_TOKEN) return res.status(403).json({ ok: false, error: "admin only" });
  const node_id = String((req.body || {}).node_id || "");
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  registry.delete(node_id);
  db.prepare("UPDATE node_settings SET removed=1, updated=? WHERE node_id=?").run(Date.now(), node_id);
  console.log(`[admin node_remove] ${node_id}`);
  res.json({ ok: true, node_id, removed: true, admin: true });
});

// 重新啟用被移除嘅 node（重裝後第一次 register 會自動 re-enable；呢個 endpoint 係俾 portal 一鍵)
app.post("/portal/node_enable", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const node_id = String((req.body || {}).node_id || "");
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  const isOwner = (nodeOwner(node_id) || {}).account === u.email;
  if (!isOwner) return res.status(403).json({ ok: false, error: "唔係你嘅 node" });
  db.prepare("UPDATE node_settings SET removed=0, updated=? WHERE node_id=?").run(Date.now(), node_id);
  res.json({ ok: true, node_id, enabled: true, hint: "node 已可重新上線（心跳/register 會帶返嚟）" });
});

app.post("/portal/forgot", (req, res) => {
  const email = String((req.body || {}).email || "").toLowerCase();
  const u = userByEmail(email);
  if (u) {
    const code = mkToken();
    db.prepare("INSERT INTO user_resets(email, code, created) VALUES(?,?,?)").run(email, code, Date.now());
    // 刪舊（<30min 前嘅）reset code
    db.prepare("DELETE FROM user_resets WHERE email=? AND created < ?").run(email, Date.now() - 1800 * 1000);
    const link = `https://swarmai.club/portal/?code=${code}`;
    if (SMTP.user && SMTP.pass) {
      try {
        const { exec } = require("child_process");
        const py = [
          "import smtplib,os,sys",
          "s=smtplib.SMTP_SSL(os.environ['HOST'],os.environ['PORT'],timeout=20)",
          "s.login(os.environ['U'],os.environ['P'])",
          `m='From: ${SMTP.user}\\nTo: '+sys.argv[1]+'\\nSubject: SwarmAI password reset\\n\\nReset your password here:\\n'+sys.argv[2]`,
          "s.sendmail(os.environ['U'],[sys.argv[1]],m.encode())",
          "s.quit()",
        ].join(";");
        exec(`python3 -c "${py}" "${email}" "${link}"`,
          { env: { ...process.env, HOST: SMTP.host, PORT: String(SMTP.port), U: SMTP.user, P: SMTP.pass }, timeout: 25000 },
          (err, stdout, stderr) => {
            if (err) console.log("[forgot] SMTP send failed:", String(stderr || err.message || err).slice(0, 300));
            else console.log("[forgot] reset link sent to", email);
          });
      } catch (e) { console.log("[forgot] smtp err:", String(e).slice(0,200)); }
    } else {
      console.log("[forgot] SMTP not configured (SMTP.user/pass missing)");
    }
  }
  // 一律回 ok，防 enum
  res.json({ ok: true, hint: "如果帳戶存在，會收到重置連結" });
});

app.post("/portal/reset", (req, res) => {
  const code = String((req.body || {}).code || "");
  const pw = String((req.body || {}).password || "");
  if (pw.length < 13) return res.status(400).json({ ok: false, error: "密碼至少 13 位" });
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw))
    return res.status(400).json({ ok: false, error: "密碼要同時有大階+細階+數字+符號" });
  const row = db.prepare("SELECT * FROM user_resets WHERE code=? AND used=0").get(code);
  if (!row) return res.status(400).json({ ok: false, error: "連結無效/過期" });
  if (Date.now() - row.created > 30 * 60 * 1000) {
    db.prepare("UPDATE user_resets SET used=1 WHERE code=?").run(code);
    return res.status(400).json({ ok: false, error: "連結過期，請再申請" });
  }
  db.prepare("UPDATE users SET pass_hash=? WHERE email=?").run(hashPass(pw), row.email);
  db.prepare("UPDATE user_resets SET used=1 WHERE code=?").run(code);
  res.json({ ok: true, message: "密碼已重置，可以登入" });
});

app.get("/portal/keys", (req, res) => {
  const t = req.get("x-swarm-token");
  const u = findUserByToken(t);
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  res.json({ ok: true, email: u.email, daily_cap: DAILY_BURN_CAP, keys: listKeysByToken(t).map(k => ({ token: k.token, label: k.label, created: k.created, scope: k.scope || "full", last_used_at: k.last_used_at, last_ip: k.last_ip })) });
});

app.post("/portal/keys/create", (req, res) => {
  const t = req.get("x-swarm-token");
  const u = findUserByToken(t);
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const label = String((req.body || {}).label || "key").slice(0, 40);
  const scope = String((req.body || {}).scope || "full");
  if (!["full", "client", "worker"].includes(scope)) return res.status(400).json({ ok: false, error: "scope 必須係 full/client/worker" });
  const ntok = mkToken();
  db.prepare("INSERT INTO user_keys(email, token, label, created, scope) VALUES(?,?,?,?,?)").run(u.email, ntok, label, Date.now(), scope);
  res.json({ ok: true, token: ntok, label, scope });
});

app.post("/portal/keys/revoke", (req, res) => {
  const t = req.get("x-swarm-token");
  const u = findUserByToken(t);
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const victim = String((req.body || {}).token || "");
  const mine = listKeysByToken(t);
  if (!victim || mine.length < 2) return res.status(400).json({ ok: false, error: "至少留一條 key（或未指定）" });
  const isMine = mine.some(k => k.token === victim);
  if (!isMine) return res.status(403).json({ ok: false, error: "唔係你嘅 key" });
  db.prepare("DELETE FROM user_keys WHERE token=? AND email=?").run(victim, u.email);
  res.json({ ok: true, remaining: mine.length - 1 });
});

app.get("/portal", (_, res) => {
  const html = fs.readFileSync(path.join(__dirname, "portal.html"));
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("html").send(html);
});

// ---- Pilot promo ----
app.get("/portal/promos", (req, res) => {
  const rows = db.prepare("SELECT code, kind, scope, value, valid_from, valid_to FROM promotions WHERE valid_to IS NULL OR valid_to > ?").all(Date.now());
  res.json({ ok: true, promos: rows, signup_bonus: SIGNUP_BONUS });
});
app.post("/admin/promo", (req, res) => {
  const t = req.get("x-swarm-token");
  if (t !== NET_TOKEN) return res.status(403).json({ ok: false, error: "admin only" });
  const { code, kind, scope, value, valid_from, valid_to, max_uses, per_user } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: "code required" });
  db.prepare("INSERT INTO promotions(code,kind,scope,value,valid_from,valid_to,max_uses,per_user) VALUES(?,?,?,?,?,?,?,?)")
    .run(String(code), kind || "discount", scope || "all", Number(value || 1), valid_from || Date.now(), valid_to || null, Number(max_uses || 0), Number(per_user === undefined ? 1 : per_user));
  res.json({ ok: true, code });
});

// 用戶兌換 coupon（reward kind → 加 token）
app.post("/portal/redeem", (req, res) => {
  const u = findUserByToken(req.get("x-swarm-token"));
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const code = String((req.body || {}).code || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "code required" });
  res.json(redeemPromo(code, u.email));
});


const BIND = (process.env.SWARM_BIND || "127.0.0.1,100.70.76.100").split(",").map(x => x.trim());
for (const host of BIND) app.listen(PORT, host, () => console.log(`[swarm-router] listening on ${host}:${PORT}`));