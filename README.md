# SwarmAI — swarm-orch

Decentralized AI compute network. **"Sleep — share your GPU; wake up — the whole network works for you."**
Cross-timezone, asynchronous compute sharing for home GPUs. MIT · [swarmai.club](https://swarmai.club) · GitHub: `SwarmAI-Club/swarm-orch`

👉 **Customer quick-start (join / run your own swarm): [docs/START_HERE.md](docs/START_HERE.md)**

## North Star

Home users lend their GPU during their local night / idle hours (Proof-of-Uptime, earning **SWAI token units**, off-chain settlement).
When they need heavy AI work during their day, they call on GPUs of users currently sleeping in other time zones — a "reverse sundial" of idle compute. Open, auditable, decentralized — no big-tech data center required.

## Architecture

```
Notebook (local, private) ── privacy filter ──┐
                                             ▼
          Router (Node)  :4900   ──  SWAI token ledger (SQLite, off-chain)
           │  beacon / node_status
           ▼
    Worker (Python, llama-server /completion)      ← optional Docker sandbox
           │  task_result (votes[])
           ▼
    weighted majority voting → final answer
```

- **方案 B (multi-agent task dispatch)** over Layer-sharding: home WAN latency/bandwidth favor dispatching whole tasks that run locally and return results.
- **Transport Phase 1** = HTTP over Tailscale mesh (`100.x`). Protocol layer is abstracted for a future libp2p / NAT-hole-punching transport (Phase 3) for external home users.

## Components

| Path | What |
|------|------|
| `router/router.js` | Node orchestrator: registry, capability matching (Jaccard), beacon/assign/vote, **SWAI token ledger** (`data/ledger.db`, off-chain), `/status` heartbeat |
| `worker-node/worker.py` | Python worker: `node_register`, serves `/health` `/beacon` `/assign`, runs llama-server `/completion` CoT votes, posts `task_result`, optional heartbeat |
| `agent/swarm_agent.py` | Client daemon ("first DNA"): timezone sleep-window detection, manual Share Mode (`auto|on|off`), `node_register` + periodic `node_status`; `--mock` for no-GPU testing |
| `sandbox/` | **Zero-Knowledge sandbox v1**: Docker image (GPU-only, read-only FS, no host mounts) + `run-worker.sh` |
| `notebook/` | Privacy filter (`regex` + custom terms masking) + MCP-style (JSON-RPC stdio) router bridge |
| `benchmarks/` | `swarm_demo.py` direct-vs-swarm scoring; `fetch_bbh.py`/`fetch_amc.py` Symphony-style set |

## Protocol (`protocol/messages.json`)

`node_register` · `beacon` · `beacon_response` · `task_assign` · `task_result` · `node_status` (v0.2) · `credit_mint` · `credit_burn`

## Security (Zero-Knowledge Sandbox)

Remote tasks run inside a container that can only reach the router/completion endpoints — **no host filesystem, no local network**. Phase 2 target: WASM. Combined with the Notebook privacy filter, private data never leaves your machine.

## Benchmarks

Live run (2026-09-17, **5× Qwythos 9B nodes** — main :8087, rtx2080ti :8087, rtx3060 :8080, rtx2060a/b :8087):
BBH-lite 6-question reasoning, **direct 50% (3/6) → swarm weighted-voting 100% (6/6)** — every question the single model got wrong was corrected by the swarm vote.
`benchmarks/results/*.json`. (Full BBH/AMC sets: `fetch_bbh.py` / `fetch_amc.py`.)

## Quick start

```bash
# Router (main node)
npm install
SWARM_ROUTER_PORT=4900 node router/router.js      # :4900, ledger in data/ledger.db

# Worker (each GPU node)
python3 worker-node/worker.py \
  --router http://100.70.76.100:4900 \
  --node-id rtx2080ti \
  --completion http://100.106.211.51:8087/completion \
  --capabilities reasoning math analysis code \
  --heartbeat 30

# Client agent (sleep-window sharing) — works without a GPU (--mock)
python3 agent/swarm_agent.py --config agent/agent.json --router http://100.70.76.100:4900 --mock --heartbeat 30

# Sandbox worker (Docker)
SWARM_COMPLETION=http://100.106.211.51:8087/completion bash sandbox/run-worker.sh rtx2080ti "reasoning math code"
```

## Tests

```bash
python3 agent/smoke_test.py      # agent register + heartbeat
node router/ledger_test.js       # SWAI token mint/burn/vote-mint
python3 benchmarks/swarm_demo.py # direct vs swarm accuracy
```

## Roadmap & Milestones

See [ROADMAP.md](ROADMAP.md). M0–M9 done (protocol v0.2, agent daemon, SWAI token ledger, sandbox, 5×Qwythos demo direct 50%→100%, notebook/privacy+MCP, monitoring+email, token strategy). Outstanding: libp2p transport · WASM sandbox · on-chain settlement (batch) · federated fine-tune (research).

## License

MIT. Free for all — use it, audit it, run your own swarm.