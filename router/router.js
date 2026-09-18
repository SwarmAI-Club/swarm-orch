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
  const { tokensIn = 0, tokensOut = 0, taskId = null, note = "", nodeId = "", kind = "vote" } = opts;
  const credit = tokensToCredit(tokensIn, tokensOut);
  db.prepare("INSERT INTO credits(account,balance) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET balance=balance+?")
    .run(account, credit, credit);
  db.prepare("INSERT INTO ledger(ts,type,account,node_id,task_id,gpu_min,credit,tokens_in,tokens_out,kind,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(Date.now(), "mint", account, nodeId || "", taskId || null, 0, credit, tokensIn || 0, tokensOut || 0, kind || "vote", note);
  return credit;
}
function ledgerBurn(account, credit, taskId, note = "") {
  const bal = creditBalance(account);
  const actual = Math.min(credit, bal);
  db.prepare("UPDATE credits SET balance=balance-? WHERE account=?").run(actual, account);
  db.prepare("INSERT INTO ledger(ts,type,account,node_id,task_id,gpu_min,credit,tokens_in,tokens_out,kind,note) VALUES(?,?,?,?,?,?,?,0,0,?,?)")
    .run(Date.now(), "burn", account, "", taskId || null, 0, actual, "task", note);
  return actual;
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
  "swarmai-fast-vision": { cap: ["vision"], tier: ["S", "A", "B", "C"], n_votes: 1, vision: true, label: "Vision (qwen2.5-vl) 自動分流" },
  "swarmai-free":     { cap: ["reasoning", "math", "analysis"], tier: ["S", "A", "B", "C"], n_votes: 3, freeOnly: true, label: "免費 node（自由分享）——唔扣費" },
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
  for (const a of adds) db.exec(`ALTER TABLE users ADD COLUMN ${a}`);
})();
db.exec(`CREATE TABLE IF NOT EXISTS user_resets(
  email TEXT,
  code TEXT PRIMARY KEY,
  created INTEGER,
  used INTEGER DEFAULT 0
)`);
// Pilot 優惠：promo 表 + 開戶送分
db.exec(`CREATE TABLE IF NOT EXISTS promotions(
  code TEXT PRIMARY KEY,
  kind TEXT,           -- discount | mint_boost
  scope TEXT,          -- tier/model/account/all
  value REAL,
  valid_from INTEGER,
  valid_to INTEGER,
  max_uses INTEGER,
  used INTEGER DEFAULT 0
)`);
const SIGNUP_BONUS = Number(process.env.SWARM_SIGNUP_BONUS || 50); // Pilot: 開戶送分
// per-node owner settings（free 持久化）
db.exec(`CREATE TABLE IF NOT EXISTS node_settings(
  node_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  free INTEGER DEFAULT 0,
  updated INTEGER
)`);
function nodeSettingFree(nodeId) { return (db.prepare("SELECT free FROM node_settings WHERE node_id=?").get(nodeId) || {}).free || 0; }
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
db.exec(`CREATE TABLE IF NOT EXISTS user_keys(
  email TEXT NOT NULL,
  token TEXT PRIMARY KEY,
  label TEXT,
  created INTEGER
)`);
db.exec(`INSERT OR IGNORE INTO user_keys(email, token, label, created) SELECT email, token, 'primary', created FROM users`);
function hashPass(p) { return crypto.scryptSync(String(p), "swaimail", 32).toString("hex"); }
function mkNodeId(email) {
  return "client-" + String(email).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
function mkToken() { return "swai-" + crypto.randomBytes(16).toString("hex"); }
function findUserByToken(t) {
  return db.prepare("SELECT u.email, u.node_id, u.created AS acct_created, k.token, k.label FROM user_keys k JOIN users u ON u.email=k.email WHERE k.token=?").get(String(t));
}
function listKeysByToken(t) {
  return db.prepare("SELECT token, label, created FROM user_keys WHERE email=(SELECT email FROM user_keys WHERE token=?)").all(String(t));
}
function userByEmail(e) { return db.prepare("SELECT * FROM users WHERE email=?").get(String(e).toLowerCase()); }

const nodes = require(CONFIG);

const app = express();
app.use(express.json());
// ---- Auth: all endpoints require X-Swarm-Token ----
app.use((req, res, next) => {
  const p0 = req.path;
  if (p0.startsWith("/portal")) return next();
  let t = req.get("x-swarm-token");
  if (!t) {
    // OpenAI-compatible: Authorization: Bearer sk-swai-... or Bearer <token>
    const auth = String(req.get("authorization") || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) t = m[1].replace(/^sk-swai-/, "");
  }
  if (t !== NET_TOKEN && !findUserByToken(t)) return res.status(401).json({ ok: false, error: "invalid x-swarm-token" });
  req.swarmToken = t;
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

function matchCapabilities(required, candidates) {
  return candidates
    .filter(n => Array.isArray(n.capabilities))
    .map(n => {
      const base = jaccard(required, n.capabilities);
      const ratio = Math.max(1, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100)));
      // rating 乘入派工優先（0.75–1.25x）；高分行食多單
      const rating = computeRating(n).score;
      const rMult = 0.75 + (rating / 100) * 0.5;
      return { node: n, score: base * (ratio / 100) * rMult };   // ratio 低 → 派工優先度低（防蜂擁）
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

app.post("/register", (req, res) => {
  const { node_id, capabilities, model, gpu, max_context, speed, share_ratio, url, free } = req.body;
  const n = registry.get(node_id) || { uptime_s: 0, last_status: null };
  Object.assign(n, { node_id, capabilities, model, gpu, max_context, speed, url, pull: !!req.body.pull });
  n.share_ratio = Math.max(0, Math.min(100, Number(share_ratio !== undefined ? share_ratio : (n.share_ratio || 100))));
  // free：DB owner 設定優先（持久）；無則用 register flag
  if (nodeSettingFree(node_id)) { n.free = true; n.free_manual = true; }
  else if (!n.free_manual) n.free = !!free;   // free node：owner 設定優先（心跳/register 唔覆寫）
  const tk = req.get("x-swarm-token");
  n.account = accountForToken(tk) || n.account || SYSTEM_ACCOUNT;
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
  // 心跳但未註冊（router 重啟後）→ 自動補註冊（node_id 已知；心跳帶返完整資料）
  if (!n && node_id) {
    n = { node_id, uptime_s: 0, last_status: null, capabilities: req.body.capabilities || [], url: "" };
    const tk = req.get("x-swarm-token");
    n.account = accountForToken(tk) || SYSTEM_ACCOUNT;
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
        const ratio = Math.max(0, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100)));
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
  const matches = matchCapabilities(required_capabilities, [...registry.values()]);

  const responses = [];
  for (const { node } of matches.slice(0, CONFIG.max_beacon_targets || 3)) {
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
  const { task_id, node_id, votes, duration_ms, tokens_in, tokens_out } = req.body || {};
  if (!task_id || !node_id) return res.status(400).json({ ok: false, error: "task_id&node_id required" });
  const rec = resultsStore.get(task_id);
  // P2 防偽：task 必須有派過俾呢個 node（assigned set）先收 result
  if (!rec || !rec.assigned || !rec.assigned.has(node_id))
    return res.status(403).json({ ok: false, error: "task 未指派俾呢個 node" });
  rec.list.push({ node_id, votes: votes || [], duration_ms: duration_ms || 0, tokens_in: tokens_in || 0, tokens_out: tokens_out || 0 });
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
app.post("/task", async (req, res) => {
  const { beacon_id, prompt, required_capabilities = ["reasoning"], n_votes = 3, temperature = 0.6 } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: "prompt required" });
  const MAX_PROMPT = Number(process.env.SWARM_MAX_PROMPT || 8000);
  if (prompt.length > MAX_PROMPT) return res.status(413).json({ ok: false, error: "prompt 太長" });
  const bid = beacon_id || crypto.randomUUID();
  const task_id = crypto.randomUUID();
  const matches = matchCapabilities(required_capabilities, [...registry.values()]);
  const pushed = [], queued = [], failed = [];
  const payload = { task_id, beacon_id: bid, prompt, n_votes, temperature };
  resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: 0, est_tokens_in: 0, est_tokens_out: 0 });

  // 自動扣費 v2：按 tokens 預估。input = prompt 字數估算; output = n_votes × n_predict 上限（保守）
  // free node：派工目標全 free → 要求者唔 burn（善意分享）
  const EST_CHARS_PER_TOKEN = 3.5;
  const reqTok = req.get("x-swarm-token");
  const tOk = reqTok ? accountForToken(reqTok) : null;
  const dispatchList = matches.slice(0, (req.body.max_targets || CONFIG.max_beacon_targets || 5));
  const targetsAllFree = dispatchList.length > 0 && dispatchList.some(m => m.node.free);
  let promoUsed = null;
  if (tOk && reqTok !== NET_TOKEN && !targetsAllFree) {
    const estIn = Math.round(prompt.length / EST_CHARS_PER_TOKEN);
    const estOut = n_votes * 512; // 預估 output (n_predict 多數情況)
    let fee = tokensToCredit(estIn, estOut);
    const promoCode = promoFromReq(req);
    if (promoCode) { const r = applyPromoToFee(promoCode, fee); fee = r.fee; promoUsed = r.promo; }
    const bal = creditBalance(tOk);
    if (bal < fee) return res.status(402).json({ ok: false, error: "SWAI 餘額不足，唔夠出 task", balance: bal, fee, est_tokens_in: estIn, est_tokens_out: estOut });
    ledgerBurn(tOk, fee, task_id, "task_estimate");
  }
  for (const { node, score } of dispatchList) {
    const urlSafe = new RegExp("^https?://(127\.0\.0\.1|100\.|localhost)").test(node.url || "");
    const assignBody = { ...payload, auth: signAssign(payload.task_id, node.node_id), ts: Date.now() };
    try {
      if (node.pull || !urlSafe) {
        const q = inbox.get(node.node_id) || [];
        q.push(assignBody);
        inbox.set(node.node_id, q);
        queued.push({ node_id: node.node_id, pull: true });
      } else {
        await fetch(`${node.url}/assign`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(assignBody), signal: AbortSignal.timeout(60000) });
        pushed.push({ node_id: node.node_id, pull: false });
      }
    } catch (e) {
      failed.push({ node_id: node.node_id, error: e.message });
    }
  }
  res.json({ ok: true, task_id, beacon_id: bid, pushed, queued, failed, promo_used: promoUsed });
});

app.get("/results/:task_id", (req, res) => {
  const rec = resultsStore.get(req.params.task_id);
  res.json({ task_id: req.params.task_id, done: rec ? rec.list.length : 0, results: rec ? rec.list : [] });
});

// ---- OpenAI-compatible gateway ----
app.get("/v1/models", (req, res) => {
  const list = Object.entries(MODEL_MAP).map(([id, m]) => ({
    id, object: "model", created: Math.floor(Date.now() / 1000),
    owned_by: "swarmai", description: m.label,
    swarmai: { n_votes: m.n_votes, vision: !!m.vision, tiers: m.tier },
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

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model = "swarmai-normal", messages = [], temperature = 0.6, max_tokens = 512 } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: { message: "messages required" }, type: "invalid_request_error" });
    const reqTok = req.get("x-swarm-token") || (req.swarmToken || "");
    const hasImage = detectImageInMessages(messages);
    const modelKey = hasImage ? "swarmai-fast-vision" : (MODEL_MAP[model] ? model : "swarmai-normal");
    const mm = MODEL_MAP[modelKey];
    const prompt = messagesToPrompt(messages);
    const images = hasImage ? extractImagesFromMessages(messages) : [];
    const topTier = mm.tier && mm.tier.length ? mm.tier[0] : "B";

    // tier 收費：fast 用 node tier 較高（如 S/A）→ 貴；normal → 平。選 max tier 計費（保守）
    // free node：targets 全 free → 要求者唔 burn（善意分享）；mixed/付費 → 正常收
    const reqAcc = reqTok ? accountForToken(reqTok) : null;
    let estFee = 0;
    let freeServed = false;

    // 派工：揀符合 modelKey tier + cap 嘅 node
    //  freeOnly → 只揀 free node；其他 model（fast/normal）免費 node 都入選（高 grade 優先）
    const wantedTiers = mm.tier;
    let candidates = [...registry.values()].filter(n => n.account && (mm.freeOnly ? n.free : (wantedTiers.includes(nodeTier(n)) || n.free)));
    console.log(`[v1] model=${modelKey} caps=${JSON.stringify(mm.cap)} tier=${JSON.stringify(mm.tier)} reg=${registry.size} cand=${candidates.map(c=>c.node_id+":"+nodeTier(c)+(c.free?"(F)":"")).join(",")}`);
    if (!candidates.length && !mm.freeOnly) {
      candidates = [...registry.values()].filter(n => n.account); // fallback 平價
      console.log(`[v1] fallback all-candidates=${candidates.map(c=>c.node_id).join(",")}`);
    }
    // 排序：score（含 rating/grade × share_ratio）為主，speed 只做 tiebreak
    const sorted = matchCapabilities(mm.cap, candidates).sort((a,b) =>
      b.score - a.score || (parseFloat(b.node.speed)||0) - (parseFloat(a.node.speed)||0));
    console.log(`[v1] sorted=${sorted.map(s=>s.node.node_id+":"+s.score.toFixed(2)).join(",")}`);
    const targets = sorted.slice(0, Math.max(1, mm.n_votes)).map(x => x.node);
    if (!targets.length) {
      return res.status(503).json({ error: { message: "no available worker" }, type: "server_error" });
    }
    // 收費決定：任何 free node 參與（或有 freeOnly model）→ 免費（唔 burn）；全部付費 node → 正常估費 burn
    freeServed = mm.freeOnly || targets.some(t => t.free);
    let promoUsed = null;
    if (reqAcc && reqTok !== NET_TOKEN && !freeServed) {
      const estIn = Math.round(prompt.length / 3.5);
      const estOut = max_tokens;
      estFee = tokensToCredit(estIn, estOut, tierCharge(topTier));
      const promoCode = promoFromReq(req);
      if (promoCode) { const r = applyPromoToFee(promoCode, estFee); estFee = r.fee; promoUsed = r.promo; }
      const bal = creditBalance(reqAcc);
      if (bal < estFee) return res.status(402).json({ error: { message: `SWAI 餘額不足 (balance ${bal}, need ${estFee})` }, type: "insufficient_balance" });
      ledgerBurn(reqAcc, estFee, null, "v1_chat_estimate");
    }
    const task_id = crypto.randomUUID();
    const beacon_id = crypto.randomUUID();
    const payload = { task_id, beacon_id, prompt, n_votes: mm.n_votes, temperature, image_data: images.length ? images : undefined };
    resultsStore.set(task_id, { ts: Date.now(), list: [], est_fee: estFee, est_tokens_in: Math.round(prompt.length/3.5), est_tokens_out: max_tokens, assigned: new Set(targets.map(t=>t.node_id)) });
    const p = [];
    console.log(`[v1] targets=${targets.map(t=>t.node_id).join(",")} n_votes=${mm.n_votes}`);
    for (const node of targets) {
      try {
        const assignBody = { ...payload, auth: signAssign(payload.task_id, node.node_id) };
        if (node.pull) {
          const q = inbox.get(node.node_id) || []; q.push(assignBody); inbox.set(node.node_id, q);
        } else {
          await fetch(`${node.url}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(assignBody), signal: AbortSignal.timeout(90000) });
        }
        p.push(node.node_id);
      } catch (e) { /* 單一等 */ }
    }
    // 等結果（上限 ~90s）
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && (!(resultsStore.get(task_id)?.list) || resultsStore.get(task_id).list.length < p.length)) {
      await new Promise(r => setTimeout(r, 400));
    }
    const rec = resultsStore.get(task_id);
    const tally = {};
    for (const r of (rec?.list || [])) for (const v of (r.votes || [])) {
      const ans = String(v.content || "").trim(); tally[ans] = (tally[ans] || 0) + (v.confidence || 0.5);
    }
    const [winner, conf] = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0] || [null, 0];
    // 精算：實際 tokens → 多退
    const tin = (rec?.list || []).reduce((s,r)=>s+(r.tokens_in||0),0);
    const tout = (rec?.list || []).reduce((s,r)=>s+(r.tokens_out||0),0);
    if (reqAcc && reqTok !== NET_TOKEN && estFee > 0) {
      const actual = tokensToCredit(tin, tout, tierCharge(topTier));
      if (estFee > actual) { const d = estFee - actual; ledgerMint(reqAcc, { tokensIn: 0, tokensOut: Math.round(d * RATE_OUT), taskId, note: "v1_refund", nodeId: reqAcc, kind: "refund" }); }
    }
    res.json({
      id: task_id, object: "chat.completion", created: Math.floor(Date.now()/1000), model: modelKey,
      choices: [{ index: 0, message: { role: "assistant", content: winner || "" }, finish_reason: winner ? "stop" : "length" }],
      usage: { prompt_tokens: Math.round(prompt.length/3.5), completion_tokens: tout, total_tokens: Math.round(prompt.length/3.5) + tout },
      swarmai: { nodes: p, votes: (rec?.list || []).map(r => r.node_id), confidence: Number(conf.toFixed(3)), est_fee: estFee, free_served: freeServed, promo_used: promoUsed, image_routed: hasImage },
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
  db.prepare("INSERT INTO user_keys(email, token, label, created) VALUES(?,?,?,?)")
    .run(e, token, "primary", Date.now());
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
  const nodes = [...registry.values()].filter(n => n.account === u.email).map(n => ({
    node_id: n.node_id, speed: parseFloat(n.speed) || 0, share_ratio: Math.max(0, Math.min(100, Number(n.share_ratio !== undefined ? n.share_ratio : 100))),
    tier: nodeTier(n), ctx: n.max_context || 0, model: n.model || "", gpu: n.gpu || "", free: !!n.free,
    abilities: n.abilities || null,
    rating: computeRating(n),
  }));
  const prof = db.prepare("SELECT display_name, pref_model, timezone, sleep_start_hour, sleep_end_hour, share_default, max_budget_per_task FROM users WHERE email=?").get(u.email) || {};
  res.json({
    ok: true, email: u.email, node_id: u.node_id, account: u.email, balance: creditBalance(u.email),
    profile: prof,
    nodes,
    economy_note: "計法：idle 1 分鐘 mint = (tok/s × 60 × share_ratio%) / 1000 SWAI；投票按實際 in/out tokens（in 5000t/SWAI、out 1000t/SWAI）。share_ratio=100 全產能；越低越少誘獎、派工優先度越低（防蜂擁）。",
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
  res.json({ ok: true, email: u.email, keys: listKeysByToken(t).map(k => ({ token: k.token, label: k.label, created: k.created })) });
});

app.post("/portal/keys/create", (req, res) => {
  const t = req.get("x-swarm-token");
  const u = findUserByToken(t);
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const label = String((req.body || {}).label || "key").slice(0, 40);
  const ntok = mkToken();
  db.prepare("INSERT INTO user_keys(email, token, label, created) VALUES(?,?,?,?)").run(u.email, ntok, label, Date.now());
  res.json({ ok: true, token: ntok, label });
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
  const { code, kind, scope, value, valid_from, valid_to, max_uses } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: "code required" });
  db.prepare("INSERT INTO promotions(code,kind,scope,value,valid_from,valid_to,max_uses) VALUES(?,?,?,?,?,?,?)")
    .run(String(code), kind || "discount", scope || "all", Number(value || 1), valid_from || Date.now(), valid_to || null, Number(max_uses || 0));
  res.json({ ok: true, code });
});


const BIND = (process.env.SWARM_BIND || "127.0.0.1,100.70.76.100").split(",").map(x => x.trim());
for (const host of BIND) app.listen(PORT, host, () => console.log(`[swarm-router] listening on ${host}:${PORT}`));