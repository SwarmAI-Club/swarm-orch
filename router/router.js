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
function hashPass(p) { return crypto.scryptSync(String(p), "swaimail", 32).toString("hex"); }
function mkNodeId(email) {
  return "client-" + String(email).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
function mkToken() { return "swai-" + crypto.randomBytes(16).toString("hex"); }
function findUserByToken(t) { return db.prepare("SELECT * FROM users WHERE token=?").get(String(t)); }
function userByEmail(e) { return db.prepare("SELECT * FROM users WHERE email=?").get(String(e).toLowerCase()); }

const nodes = require(CONFIG);

const app = express();
app.use(express.json());
// ---- Auth: all endpoints require X-Swarm-Token ----
app.use((req, res, next) => {
  const p0 = req.path;
  if (p0 === "/portal" || p0.startsWith("/portal/login") || p0.startsWith("/portal/signup")) return next();
  const t = req.get("x-swarm-token");
  if (t !== NET_TOKEN && !findUserByToken(t)) return res.status(401).json({ ok: false, error: "invalid x-swarm-token" });
  next();
});

const registry = new Map();       // node_id -> capabilities/model/gpu/url
const pendingBeacons = new Map(); // beacon_id -> {required, responses, ts}
const resultsStore = new Map();   // task_id -> {ts, list: task_result[]}

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
  Object.assign(n, { node_id, capabilities, model, gpu, max_context, speed, url });
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


// ---- Client portal (login -> token -> SWAI balance) ----
app.post("/portal/signup", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 8) return res.status(400).json({ ok: false, error: "email + password(>=8) required" });
  const e = String(email).toLowerCase();
  if (userByEmail(e)) return res.status(409).json({ ok: false, error: "email already registered" });
  const token = mkToken();
  const node_id = mkNodeId(e);
  db.prepare("INSERT INTO users(email,pass_hash,token,node_id,created) VALUES(?,?,?,?,?)")
    .run(e, hashPass(password), token, node_id, Date.now());
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

app.get("/portal", (_, res) => {
  const html = fs.readFileSync(path.join(__dirname, "portal.html"));
  res.type("html").send(html);
});


app.listen(PORT, "0.0.0.0", () => console.log(`[swarm-router] listening :${PORT} (${registry.size} registered)`));