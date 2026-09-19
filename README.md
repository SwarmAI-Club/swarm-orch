# SwarmAI — swarm-orch

Decentralized AI compute network. **"Sleep — share your GPU; wake up — the whole network works for you."**
Cross-timezone, asynchronous compute sharing for home GPUs. MIT · [swarmai.club](https://swarmai.club) · GitHub: `SwarmAI-Club/swarm-orch`

👉 **Customer quick-start (join / run your own swarm): [docs/START_HERE.md](docs/START_HERE.md)**

## North Star

Home users lend their GPU during their local night / idle hours (Proof-of-Uptime, earning **SWAI token units**, off-chain settlement).
When they need heavy AI work during their day, they call on GPUs of users currently sleeping in other time zones — a "reverse sundial" of idle compute. Open, auditable, decentralized — no big-tech data center required.

**The faith that guides it** (community covenant):

> SwarmAI is built by its members — a mutual-aid AI network using each person's idle time to create maximum value. It doesn't demand the most cutting-edge agent; simply the willingness to build on what exists. The Club grows healthy and positive, expanding in scale, upgrading continuously, refining the in-group experience — with empathy and mutual support, moving into the future together. Everyone who's willing to build is a member.

**Collective Intelligence vision**: the group keeps attracting free developers who build on this platform — more handy tools, autonomous agents, and project-owned models for everyday users — evolving from *shared compute* into *shared intelligence*, a growing collective mind.

## Architecture

```
Notebook (local, private) ── privacy filter ──┐
                                             ▼
          Router (Node)  :4900   ──  SWAI ledger (SQLite) + portal/:4900
            │  dispatch (own-first) / capability match / vote / idle mint
            ▼
     Worker (Python, llama-server /completion 或 specialty adapter)
            │  task_result (votes[] / images[])
            ▼
    weighted majority voting → final answer
       ▲
Portal（web: signup/login/keys/node-settings/topup）+ Telegram 客服/社群管家
```

- **方案 B (multi-agent task dispatch)** over Layer-sharding: home WAN latency/bandwidth favor dispatching whole tasks that run locally and return results.
- **Transport Phase 1** = HTTP over Tailscale mesh (`100.x`). Protocol layer is abstracted for a future libp2p / NAT-hole-punching transport (Phase 3) for external home users.
- **自己機優先**：用戶自己機上線 → router 優先派自己（免扣 SWAI）；自己機唔夠先借出面，balance 唔夠自動 fallback 返自己機+free machine。

## Components

| Path | What |
|------|------|
| `router/router.js` | Node orchestrator: registry, capability matching (Jaccard + own-priority + offline filter), beacon/assign/vote, **SWAI token ledger** (`data/ledger.db`), `/status` heartbeat, **dispatch_pref 自己機優先/fallback**, **USDC Polygon topup 掃鏈**, `/portal/*` web API |
| `router/portal.html` | Portal web UI: signup/login, keys(scope), per-node 設定(Free/sleep/share/suspend/移除), **充值卡**, **新增 node modal**, 派工策略 |
| `worker-node/worker.py` | Python worker: `node_register`, `/health` `/beacon` `/assign`, llama-server `/completion` CoT votes, posts `task_result`；**`--adapter image/video`**（SD-WebUI/ComfyUI 等 specialty 服務）|
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

## Public join (no Tailscale needed)

External clients/web users bypass Tailscale entirely — everything goes through the public gateway:

- **Portal**: https://swarmai.club/portal/ → signup/login → get your own API token (SWAI balance shown)
- **Primary = 443 + path proxy (no NAT needed, Cloudflare-fronted)**:
  - Portal: `https://swarmai.club/portal/`
  - Router API: `https://swarmai.club/swarm/*` (e.g. `/swarm/nodes`, `/swarm/register`) with `X-Swarm-Token`
- Optional rare port (direct origin only): `http://swarmai.club:6769/portal/` + `/swarm/*` — requires router NAT forward TCP 6769 → origin LAN IP (Cloudflare does not proxy non-standard ports).
- **Router API over public HTTPS**: `https://swarmai.club/swarm/...` (e.g. `/swarm/nodes`, `/swarm/register`) with `X-Swarm-Token`
- Clients point worker/agent at `--router https://swarmai.club/swarm/` — no VPN, unlimited users (Cloudflare in front; your identity = email).

## Quick start

```bash
# Router (main node)
npm install
export SWARM_API_TOKEN=<network-token>        # REQUIRED by all clients
export SWARM_ROUTER_SECRET=<same-or-own>      # /assign HMAC 簽名（防直撳）
export SWARM_DEPOSIT_WALLET=0x…               # USDC 充值收款地址（Polygon）
SWARM_ROUTER_PORT=4900 node router/router.js   # :4900, SWAI ledger data/ledger.db (auth on)

# Worker (each GPU node)
python3 worker-node/worker.py \
  --router http://100.70.76.100:4900 --token "$SWARM_API_TOKEN" \
  --node-id rtx2080ti \
  --completion http://100.106.211.51:8087/completion \
  --capabilities reasoning math analysis code \
  --heartbeat 30

# Client agent (sleep-window sharing) — works without a GPU (--mock)
SWARM_API_TOKEN="$SWARM_API_TOKEN" python3 agent/swarm_agent.py --config agent/agent.json --router http://100.70.76.100:4900 --mock --heartbeat 30

# Sandbox worker (Docker)
SWARM_COMPLETION=http://100.106.211.51:8087/completion bash sandbox/run-worker.sh rtx2080ti "reasoning math code"
```

## Auth & SWAI (contribution)

- **Auth**: every router endpoint requires header `X-Swarm-Token: <token>`. Start router with `SWARM_API_TOKEN=<network-token>`; clients (worker/agent/monitor) use the same token (`--token` / `SWARM_API_TOKEN`).
- **SWAI (contribution)**:
  - Idle (Proof-of-Uptime): `IDLE_SHARING` heartbeat × node `speed` → tokens → 按 `RATE_OUT`(1000 tok/SWAI) mint.
  - Task vote: providers mint by actual `tokens_in/out`（`RATE_IN` 5000 / `RATE_OUT` 1000）.
  - Specialty (image/video): mint/burn by `units × unitPrice`.
  - **自己機優先**：自己 account 機（`dispatch_pref=self`）→ 免費自用；token 唔夠自動 fallback 自己機+free machine。
  - **充值**：USDC on Polygon → SWAI（1 USDC = 100 SWAI, `SWARM_DEPOSIT_WALLET` + `POLYGON_RPC`）。
  - Query: `GET /credits/<account>` 或 Portal `/portal/me`（含 `dispatch` + `topup` info）。

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