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

### M5 ✅ Swarm-Reasoning Demo（5× Qwythos）— done 2026-09-17: BBH-lite 6Q **direct 50% → swarm 100%**（+rtx2060a/b 於 2026-09-17 第三輪驗證，全系統 audit pass）
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

### M8 ✅ SWAI Token 策略定案（off-chain 分帳 + tokenomics doc）— done 2026-09-17
- SWAI token 單位作貢獻/扣費點；**唔上鏈住**（batch/checkpoint 為未來 on-chain 路線）
- `docs/TOKENOMICS.md`（mint/burn 規則、供應通脹建議、on-chain 遷移）
- 口徑：網頁/README 由「點數 Credit」改為「SWAI token（off-chain 分帳）」

### M9 ✅ 平台化：keys scope + 每日 burn quota + node 綁定 + 私隱保證 — done 2026-09-19
- Keys 分 `full/client/worker` scope；last-used IP/time 追蹤；revoke 即時
- 每日 burn 上限（`SWARM_DAILY_BURN_CAP`=2000/d）；node_id 綁定擁有人（防冒充）
- 任務內容零保留（ephemeral）；log 只 metadata；`[img]` prompt log 洩漏已修
- Telegram 社群管家 bot（group 監察/廣播/好意見）

### M10 ✅ 自己機優先 + USDC 充值 + specialty — done 2026-09-19
- `dispatch_pref`（self/fastest/free-first）：自己機優先免費、balance 唔夠 fallback 自己機+free
- USDC on Polygon 充值（1 USDC=100 SWAI，min 5）：deposits 表 + `scanPolygonTx`
- 離線偵測（>5min 唔派工）+ per-node Free/sleep/share/suspend/移除 portal 管理
- Specialty node：`swarmai-image`（SD-WebUI）/ `swarmai-video`（Wan）adapter + `/v1/images/generations`
- Portal 充值卡／新增 node modal／時區互補 homepage
- `docs/ARCHITECTURE.md` §10b/10c/10d + `docs/ECONOMY.md` §10-12 + SUPPORT_BOT.md 社群管家 section

## Out of scope / Later
- libp2p / NAT punch（Phase 3）
- ~~Token ledger~~ → SWAI token（M8 定案：off-chain，on-chain 排期）
- WASM sandbox（先 Docker）
- Federated fine-tune / speculative decoding over WAN（research，未排期）
- **USDC 充值自動掃鏈**：MVP 依賴 `/portal/topup/submit`（人手提交 tx）；自動 `setInterval` scan blockchain 係將來
- Wan/ComfyUI video adapter：stub，待填 `WAN_API_URL` 實作
- 收益回流聲明（開發/model upgrade/自研 model）網頁承諾：政策層，暫未上網站

## License
MIT — free for all. See `LICENSE`.