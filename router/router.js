const path = require("path");
const fs = require("fs");
const express = require("express");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const CONFIG = process.env.SWARM_CONFIG || path.join(__dirname, "..", "config", "nodes.json");
const PORT = process.env.SWARM_ROUTER_PORT || 4900;
const CREDIT_RATE_PM = Number(process.env.SWARM_CREDIT_RATE_PM || 10); // SWAI per GPU-min (task votes)
const UPTIME_RATE_PM = Number(process.env.SWARM_UPTIME_RATE_PM || 2);  // SWAI per idle min (Proof-of-Uptime)
const NET_TOKEN = process.env.SWARM_API_TOKEN || "dev-insecure-token"; // REQUIRED, all endpoints check it

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
db.exec(`CREATE TABLE IF NOT EXISTS credits(
  node_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT NOT NULL,
  task_id TEXT,
  gpu_min REAL,
  credit INTEGER NOT NULL,
  note TEXT
)`);
function creditBalance(nodeId) {
  const row = db.prepare("SELECT balance FROM credits WHERE node_id=?").get(nodeId);
  return row ? row.balance : 0;
}
function ledgerMint(nodeId, gpuMin, taskId, note = "") {
  const credit = Math.max(1, Math.round((gpuMin || 0) * CREDIT_RATE_PM));
  db.prepare("INSERT INTO credits(node_id,balance) VALUES(?,?) ON CONFLICT(node_id) DO UPDATE SET balance=balance+?").run(nodeId, credit, credit);
  db.prepare("INSERT INTO ledger(ts,type,node_id,task_id,gpu_min,credit,note) VALUES(?,?,?,?,?,?,?)")
    .run(Date.now(), "mint", nodeId, taskId || null, gpuMin || 0, credit, note);
  return credit;
}
function ledgerBurn(nodeId, credit, taskId, note = "") {
  const bal = creditBalance(nodeId);
  const actual = Math.min(credit, bal);
  db.prepare("UPDATE credits SET balance=balance-? WHERE node_id=?").run(actual, nodeId);
  db.prepare("INSERT INTO ledger(ts,type,node_id,task_id,gpu_min,credit,note) VALUES(?,?,?,?,?,?,?)")
    .run(Date.now(), "burn", nodeId, taskId || null, 0, actual, note);
  return actual;
}

// ---- Client portal: users (email login -> own API token) ----
db.exec(`CREATE TABLE IF NOT EXISTS users(
  email TEXT PRIMARY KEY,
  pass_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  node_id TEXT NOT NULL,
  created INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_resets(
  email TEXT,
  code TEXT PRIMARY KEY,
  created INTEGER,
  used INTEGER DEFAULT 0
)`);
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
  const t = req.get("x-swarm-token");
  if (t !== NET_TOKEN && !findUserByToken(t)) return res.status(401).json({ ok: false, error: "invalid x-swarm-token" });
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
    .map(n => ({ node: n, score: jaccard(required, n.capabilities) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

app.post("/register", (req, res) => {
  const { node_id, capabilities, model, gpu, max_context, speed, url } = req.body;
  const n = registry.get(node_id) || { uptime_s: 0, last_status: null };
  Object.assign(n, { node_id, capabilities, model, gpu, max_context, speed, url, pull: !!req.body.pull });
  registry.set(node_id, n);
  res.json({ ok: true, nodes: registry.size, uptime_rate_pm: UPTIME_RATE_PM, credit_rate_pm: CREDIT_RATE_PM });
});

// protocol v0.2: node_status heartbeat (+ Proof-of-Uptime accumulation)
app.post("/status", (req, res) => {
  const { node_id, status, vram_used_gb, model_loaded, load, sleeping, ts } = req.body || {};
  const n = registry.get(node_id);
  if (n) {
    const nowMs = Date.now();
    const tsS = (ts && ts < 1e12) ? Number(ts) : (nowMs / 1000);
    const last = n.last_status;
    if (last && last.__state === "IDLE_SHARING") {
      n.uptime_s += (nowMs - last.__tsMs) / 1000;
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
  const { task_id, node_id, votes, duration_ms } = req.body || {};
  if (!task_id || !node_id) return res.status(400).json({ ok: false, error: "task_id&node_id required" });
  const rec = resultsStore.get(task_id) || { ts: Date.now(), list: [] };
  rec.list.push({ node_id, votes: votes || [], duration_ms: duration_ms || 0 });
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
  // Time-Bank: 每個 provider 按 duration_ms 折算 credit 入帳
  const mints = [];
  for (const r of results) {
    const gpuMin = (r.duration_ms || 0) / 60000;
    if (r.node_id && gpuMin > 0) {
      const c = ledgerMint(r.node_id, gpuMin, r.task_id || req.body.task_id || null, "vote");
      mints.push({ node_id: r.node_id, credit: c, gpu_min: Number(gpuMin.toFixed(3)) });
    }
  }
  const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  res.json({ winner: winner?.[0], confidence: winner?.[1], tally, mints });
});

// ---- Time-Bank ledger endpoints ----
app.post("/ledger/mint", (req, res) => {
  const { node_id, task_id, gpu_min } = req.body || {};
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
  const credit = ledgerMint(node_id, Number(gpu_min || 0), task_id, "manual");
  res.json({ ok: true, node_id, credit, balance: creditBalance(node_id) });
});

app.post("/ledger/burn", (req, res) => {
  const { node_id, credit, task_id } = req.body || {};
  if (!node_id || !credit) return res.status(400).json({ ok: false, error: "node_id & credit required" });
  const actual = ledgerBurn(node_id, Number(credit), task_id, "manual");
  res.json({ ok: true, node_id, burned: actual, balance: creditBalance(node_id) });
});

app.get("/credits/:node", (req, res) => {
  res.json({ node_id: req.params.node, balance: creditBalance(req.params.node) });
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
  // PoU: IDLE_SHARING 累積 uptime >= 1min → mint SWAI
  for (const n of registry.values()) {
    if (n.uptime_s >= 60) {
      const mins = n.uptime_s / 60;
      const credit = Math.max(1, Math.round(mins * UPTIME_RATE_PM));
      ledgerMint(n.node_id, mins, null, "uptime");
      n.uptime_s -= mins * 60;
      console.log(`[uptime] ${n.node_id} +${credit} SWAI (${mins.toFixed(1)}min idle)`);
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

  // 自動扣費：一般用戶（user token）要先有餘額，一次任務收 TASK_FEE（default 10 SWAI）
  const TASK_FEE = Number(process.env.SWARM_TASK_FEE || 10);
  const reqTok = req.get("x-swarm-token");
  const reqUser = reqTok ? findUserByToken(reqTok) : null;
  if (reqUser && reqTok !== NET_TOKEN) {
    const bal = creditBalance(reqUser.node_id);
    if (bal < TASK_FEE) return res.status(402).json({ ok: false, error: "SWAI 餘額不足，唔夠出 task", balance: bal, fee: TASK_FEE });
    ledgerBurn(reqUser.node_id, TASK_FEE, task_id, "task");
  }
  for (const { node, score } of matches.slice(0, (req.body.max_targets || CONFIG.max_beacon_targets || 5))) {
    const urlSafe = new RegExp("^https?://(127\.0\.0\.1|100\.|localhost)").test(node.url || "");
    try {
      if (node.pull || !urlSafe) {
        const q = inbox.get(node.node_id) || [];
        q.push({ ...payload, ts: Date.now() });
        inbox.set(node.node_id, q);
        queued.push({ node_id: node.node_id, pull: true });
      } else {
        await fetch(`${node.url}/assign`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
        pushed.push({ node_id: node.node_id, pull: false });
      }
    } catch (e) {
      failed.push({ node_id: node.node_id, error: e.message });
    }
  }
  res.json({ ok: true, task_id, beacon_id: bid, pushed, queued, failed });
});

app.get("/results/:task_id", (req, res) => {
  const rec = resultsStore.get(req.params.task_id);
  res.json({ task_id: req.params.task_id, done: rec ? rec.list.length : 0, results: rec ? rec.list : [] });
});

app.get("/tasks/poll", (req, res) => {
  const { node_id } = req.query;
  if (!node_id) return res.status(400).json({ ok: false, error: "node_id required" });
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
  res.json({ ok: true, email: e, api_token: token, node_id });
});

app.post("/portal/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = userByEmail(email);
  if (!u || u.pass_hash !== hashPass(password)) return res.status(401).json({ ok: false, error: "bad credentials" });
  res.json({ ok: true, email: u.email, api_token: u.token, node_id: u.node_id, balance: creditBalance(u.node_id) });
});

app.get("/portal/me", (req, res) => {
  const t = req.get("x-swarm-token");
  const u = findUserByToken(t);
  if (!u) return res.status(401).json({ ok: false, error: "invalid token" });
  const led = db.prepare("SELECT * FROM ledger WHERE node_id=? ORDER BY id DESC LIMIT 20").all(u.node_id);
  res.json({ ok: true, email: u.email, node_id: u.node_id, balance: creditBalance(u.node_id), journal: led });
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
        require("child_process").exec(
          `python3 -c "import smtplib,os,sys; s=smtplib.SMTP_SSL(os.environ['HOST'],os.environ['PORT']); s.login(os.environ['U'],os.environ['P']); m='From: support@swarmai.club\nTo: '+sys.argv[1]+'\nSubject: SwarmAI password reset\n\nReset your password here:\n'+sys.argv[2]; s.sendmail(os.environ['U'],[sys.argv[1]],m.encode()); s.quit()" "${email}" "${link}"`,
          { env: { ...process.env, HOST: SMTP.host, PORT: String(SMTP.port), U: SMTP.user, P: SMTP.pass }, timeout: 20000 },
          (err) => { if (err) console.log("[forgot] SMTP send failed:", String(err.message).slice(0, 140)); });
      } catch (e) { console.log("[forgot] smtp err:", String(e).slice(0,120)); }
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
  res.type("html").send(html);
});


const BIND = (process.env.SWARM_BIND || "127.0.0.1,100.70.76.100").split(",").map(x => x.trim());
for (const host of BIND) app.listen(PORT, host, () => console.log(`[swarm-router] listening on ${host}:${PORT}`));