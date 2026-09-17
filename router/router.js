const path = require("path");
const fs = require("fs");
const express = require("express");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const CONFIG = process.env.SWARM_CONFIG || path.join(__dirname, "..", "config", "nodes.json");
const PORT = process.env.SWARM_ROUTER_PORT || 4900;
const CREDIT_RATE_PM = Number(process.env.SWARM_CREDIT_RATE_PM || 10); // credit per GPU-min

// ---- Time-Bank ledger (SQLite) ----
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
const nodes = require(CONFIG);

const app = express();
app.use(express.json());

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
  registry.set(node_id, { node_id, capabilities, model, gpu, max_context, speed, url });
  res.json({ ok: true, nodes: registry.size });
});

// protocol v0.2: node_status heartbeat
app.post("/status", (req, res) => {
  const { node_id, status, vram_used_gb, model_loaded, load, sleeping, ts } = req.body || {};
  const n = registry.get(node_id);
  if (n) {
    n.last_status = { status, vram_used_gb, model_loaded, load, sleeping, ts: ts || Date.now() };
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

// periodic prune: 3 0-min TTL for beacons/results (memory hygiene)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of pendingBeacons) if (v.ts && v.ts < cutoff) pendingBeacons.delete(k);
  for (const [k, v] of resultsStore) if (v.ts && v.ts < cutoff) resultsStore.delete(k);
}, 5 * 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => console.log(`[swarm-router] listening :${PORT} (${registry.size} registered)`));