const path = require("path");
const express = require("express");
const crypto = require("crypto");

const CONFIG = process.env.SWARM_CONFIG || path.join(__dirname, "..", "config", "nodes.json");
const PORT = process.env.SWARM_ROUTER_PORT || 4900;
const nodes = require(CONFIG);

const app = express();
app.use(express.json());

const registry = new Map();       // node_id -> capabilities/model/gpu/url
const pendingBeacons = new Map(); // beacon_id -> {required, responses:[]}

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
  pendingBeacons.set(beacon_id, { required: required_capabilities, responses });
  res.json({ beacon_id, responses });
});

app.post("/vote", async (req, res) => {
  // aggregate existing task_results into weighted majority vote
  pendingBeacons.delete(req.body.beacon_id);
  const results = req.body.results || [];
  const tally = {};
  for (const r of results) for (const v of r.votes || []) {
    const ans = String(v.content).trim();
    tally[ans] = (tally[ans] || 0) + (v.confidence || 0.5);
  }
  const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  res.json({ winner: winner?.[0], confidence: winner?.[1], tally });
});

app.get("/nodes", (_, res) => res.json([...registry.values()]));

app.listen(PORT, "0.0.0.0", () => console.log(`[swarm-router] listening :${PORT} (${registry.size} registered)`));