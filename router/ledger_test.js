// SwarmAI ledger test — spawn router :5911, exercise mint/burn/credits/vote-mint.
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");

const PORT = 5911;
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTER = path.join(__dirname, "router.js");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-ledgertest-"));

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const hdrs = data ? { "content-type": "application/json", "x-swarm-token": "test-token" } : { "x-swarm-token": "test-token" };
    const r = http.request(`${BASE}${url}`, { method, headers: hdrs }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error("CDATA "+url+" -> "+s.slice(0,140))); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitReady(t = 15) {
  const t0 = Date.now();
  while (Date.now() - t0 < t * 1000) {
    try { await req("GET", "/nodes"); return; } catch (e) { await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error("router not ready");
}

(async () => {
  const child = spawn(process.execPath, [ROUTER], {
    env: { ...process.env, SWARM_ROUTER_PORT: String(PORT), SWARM_CREDIT_RATE_PM: "10", SWARM_DATA_DIR: DATA_DIR, SWARM_API_TOKEN: "test-token" },
    stdio: "ignore",
  });
  try {
    await waitReady();
    const NODE = "ledger-test-node";
    const m = await req("POST", "/ledger/mint", { node_id: NODE, gpu_min: 1 });
    if (m.credit !== 10) throw new Error("mint fail: " + JSON.stringify(m));
    let bal = (await req("GET", `/credits/${NODE}`)).balance;
    if (bal !== 10) throw new Error("balance != 10");
    const b = await req("POST", "/ledger/burn", { node_id: NODE, credit: 3 });
    if (b.burned !== 3 || b.balance !== 7) throw new Error("burn fail");
    const v = await req("POST", "/vote", {
      task_id: "t1", results: [{ node_id: NODE, duration_ms: 30000, votes: [{ content: "A", confidence: 0.8 }] }],
    });
    // 30s = 0.5 min * 10 = 5 credit
    const minted = v.mints.find(x => x.node_id === NODE);
    if (!minted || minted.credit !== 5) throw new Error("vote mint fail: " + JSON.stringify(v));
    bal = (await req("GET", `/credits/${NODE}`)).balance;
    if (bal !== 12) throw new Error("final balance != 12, got " + bal);
    if (v.winner !== "A") throw new Error("vote winner fail");
    const latest = await req("GET", "/ledger/latest?limit=5");
    if (!Array.isArray(latest) || latest.length < 3) throw new Error("ledger latest fail");
    console.log("LEDGER ALL PASS  balance=" + bal + " winner=" + v.winner);
  } finally {
    child.kill("SIGTERM");
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
})().catch((e) => { console.error("LEDGER FAIL:", e.message); process.exit(1); });