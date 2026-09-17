# SwarmAI — Roadmap / Milestones

> Open-source, MIT · Repo: **SwarmAI-Club/swarm-orch** · Web: swarmai.club

## North Star
「**瞓覺時借 GPU、醒來成個網絡幫你**」— 跨時區、異步的去中心化 AI 算力網絡。
家用 GPU 喺各自時區嘅深夜/空閒時間共享算力（Proof-of-Uptime），日頭反過來呼叫其他時區嘅算力 — 達致「**算力民主化**」，對抗集中式雲端算力壟斷。

## Design Decisions（來自設計 review 2026-09-17）
- **方案 B（Multi-agent 任務分派）為先** — 家用網絡 latency/bandwidth 限制下，Layer sharding（方案 A）唔實際；swarm-orch 已經係方案 B（Node router + Python worker）
- **三語 messages**：`node_register` / `beacon` / `beacon_response` / `task_assign` / `task_result`（`protocol/messages.json`），Phase 2 加 `node_status`（heartbeat）
- **Transport Phase 1 = HTTP over Tailscale (100.x)**；protocol 層抽象，Phase 3 換 libp2p/NAT punch（開放外部家用機）
- **Voting**：weighted majority `Σ(confidence_i × I(a_i=a))`（Symphony 概念）
- **信譽/信用**：先做輕量 Time-Bank credit ledger（SQLite），唔預先上 token/blockchain
- **安全**：worker 行 Docker/sandbox（GPU-only，唔 mount host FS）→ 信任閘門

## Milestones

### M0 ✅ 里程碑基建 — done 2026-09-17
MILESTONES.md（cluster tracker）+ 本 ROADMAP。

### M1 ✅ Protocol v0.2（`node_status` heartbeat）— done 2026-09-17
- `protocol/messages.json` 加 `node_status`：
  - fields: `type="node_status"`, `node_id`, `status` (IDLE_SHARING | USER_OCCUPIED), `vram_used_gb`, `model_loaded`, `load`, `sleeping` (bool), `ts`
- backward compatible（唔郁 5 種舊 message）

### M2 ✅ `swarm-agent` 客戶端守護進程 — done 2026-09-17
- `agent/swarm_agent.py`：本地時區/睡眠窗口設定（JSON config）、手動 Share Mode、
  上線 `node_register` + 定期 `node_status` heartbeat（loop 可設定，default 60s）
- `--mock` mode：唔使真 GPU/ollama 都跑到嚟驗證
- `worker-node/worker.py` 擴充 heartbeat 輸出版（agent 同 worker 共用邏輯）

### M3 ✅ Time-Bank Credit Ledger (SQLite) — done 2026-09-17
- Router 起 `ledger.db`（`nodes` + `ledger` table）
- Endpoints：`POST /ledger/mint`（provider 賺，按 GPU-min）、`POST /ledger/burn`（requester 扣）、`GET /credits/:node`、`GET /ledger/latest`
- `POST /vote` 完成時自動 mint（用 `duration_ms` 折算 credit）

### M4 ✅ Docker Sandbox (信任閘門) — done 2026-09-17
- `sandbox/Dockerfile`：python + requests，**無 host FS mount**、淨係 network 接 router
- `sandbox/run-worker.sh`：起 container worker，環境變數傳 router/completion/capabilities
- 目標：remote 任務只能 call `/completion`，接觸唔到本機檔案系統

### M5 ✅ Swarm-Reasoning Demo（3× → 5× Qwythos）— done 2026-09-17: BBH-lite 6Q direct 50% → swarm 100% (+rtx2060a/b 之後再驗證)
- live nodes（2026-09-17 校準）：main `100.70.76.100:8087`（qwythos-1m-main）、
  rtx2080ti `100.106.211.51:8087`（qwythos-1m，**nodes.json port 修正 8085→8087**）、
  rtx3060 `100.97.2.13:8080`（qwythos-1m）
- BBH subset：direct（單 node）vs swarm weighted voting → `benchmarks/results/`
- 賣點：「瞓覺幫你升級 Qwythos」— 多 node 投票逼近大模型邏輯水平

### M6 ✅ Notebook Privacy Filter — done 2026-09-17
- `notebook/privacy_filter.py`：Regex + 自訂 redaction list 遮罩 email/電話/人名/路徑/金額先出網
- `notebook/mcp_server.py`：MCP（stdio）stub，將 router 嘅 task 工具暴露俾 Notebook 前端

### M7 ✅ Docs / Website / Memory / GitHub sync — done 2026-09-17
- README（EN，OSS-ready）＋ 本 Roadmap 更新
- swarmai.club landing 加 Milestones 段
- SESSION_MEMORY + MILESTONES.md 更新
- `git commit`（Big Pickle）＋ `git push origin master`

## Out of scope / Later
- libp2p / NAT punch（Phase 3）
- Token / blockchain ledger（Time-Bank 穩定之後先諗）
- WASM sandbox（先 Docker）
- Federated fine-tune / speculative decoding over WAN（research，未排期）

## License
MIT — free for all. See `LICENSE`.