# 🐝 SwarmAI — START HERE（客戶版）

> **「瞓覺時借出 GPU，醒來成個網絡幫你。」**
> 一部 home GPU 唔夠大，但成個網絡嘅閒置 GPU 合起身就夠大。
> 開源（MIT）· 去中心化 · 私隱沙盒 · swarmai.club · support@swarmai.club

---

## 1. 呢個 project 係咩

SwarmAI 係一個**跨時區嘅去中心化 AI 算力網絡**：

- **瞓覺就賺** — 喺你當地深夜/空閒時間，你部機開放 GPU 入網（可設 00:00–07:00 或手動切換），按 **Proof-of-Uptime** 賺 **SWAI token 單位**（off-chain 分帳）。
- **醒來超強** — 日頭你需要大量 AI 任務時，呼叫其他時區正喺「瞓覺掛機」嘅 GPU。
- **群體升級 Qwythos** — 同一問題分俾多個節點並行推理，加權投票：實測 **direct 50% → swarm 100%**（單一模型錯嘅題俾投票救返）。
- **私隱唔出街** — 遠端任務只喺沙盒入面行（讀唔到你部機）；Notebook 私密數據由本地過濾器遮罩先出網。
- **絕唔係 Skynet** — 冇中央大腦、個個手動可拔線、算力打散喺人間 = 算力民主化。

**時間線：** 而家 5 節點（全 Qwythos）已 live 測試中；外部家用機 P2P 接入（libp2p 打洞）排緊隊。想領先加入，email `support@swarmai.club`。

---

## 2. 硬件要求

| 項目 | 要求 |
|------|------|
| GPU | NVIDIA (8–24GB VRAM 都得；更高更好) |
| 系統 | Windows 10/11 或 Linux（WSL2 CUDA / native CUDA） |
| 模型運行 | llama.cpp llama-server（本 repo worker 直接 call `/completion`） |
| 網絡 | 能出 internet；P2P 階段準備 VPN/打洞（現階段 Tailscale mesh） |

- GPU 唔一定要！可以先用 `--mock` 模式行 worker/agent 學埋嘢。

---

## 3. 快速開始（自己起一個 swarm / 或者做一個 node）

### 3a. Router（主節點，起中樞）

```bash
git clone https://github.com/SwarmAI-Club/swarm-orch.git
cd swarm-orch
npm install
SWARM_ROUTER_PORT=4900 node router/router.js
# → http://:4900，Time-Bank ledger 喺 data/ledger.db
```

### 3b. Worker（每部 GPU 節點 — 收任務 / 跑推理 / 回傳 votes）

```bash
python3 worker-node/worker.py \
  --router http://<ROUTER_IP>:4900 \
  --node-id my-gpu-1 \
  --completion http://127.0.0.1:<llama-server-port>/completion \
  --model qwythos-1m --gpu "RTX 4080 16GB" --vram 16 \
  --capabilities reasoning math code \
  --heartbeat 30
```

### 3c. 起 llama-server（你部機嘅模型）

```bash
# 例：Qwythos 9B（GGUF，你部機裝 llama.cpp 之後）
./llama-server -m /path/to/Qwythos-9B-....gguf \
  --host 0.0.0.0 --port 8080 -ngl 99 -c 32768 --parallel 1 --alias qwythos-1m
```

### 3d. 「瞓覺就賺」agent（守護進程，設睡眠窗口 + 手動 Share Mode）

```bash
python3 agent/swarm_agent.py --config agent/agent.json \
  --router http://<ROUTER_IP>:4900 --heartbeat 30
```
`agent/agent.json` 入面：
```json
{
  "node_id": "homesleep-01",
  "timezone": "Asia/Hong_Kong",
  "sleep_start_hour": 0,
  "sleep_end_hour": 7,
  "share_mode": "auto",
  "vram_total_gb": 16,
  "model": "qwythos-1m",
  "capabilities": ["reasoning", "math", "analysis", "code"]
}
```
- `share_mode`：`auto`=跟睡眠窗口 · `on`=永遠共享 · `off`=永遠唔共享（完全控制權喺你手）

### 3e. Docker 沙盒 worker（安全示範入口）

```bash
docker build -f sandbox/Dockerfile -t swarm-worker .   # 喺 repo root 行
SWARM_ROUTER=http://<ROUTER_IP>:4900 \
SWARM_COMPLETION=http://127.0.0.1:8080/completion \
bash sandbox/run-worker.sh my-gpu-1 "reasoning math code"
```
沙盒 = **GPU-only + read-only FS + 無 host mount**：遠端任務碰唔到你部機。

---

## 4. 用 AI — 點解扣點數

- **自己機優先（免費）**：用自己部機唔扣點。
- **借其他時區 idle 機**：按 GPU-min 計，扣 SWAI token。
- **賺**：你上線/瞓覺時間累積 Credit（Proof-of-Uptime）；完成任務回傳投票都會 mint 少少。
- 而家係 off-chain SWAI 分帳（SQLite）；on-chain 係日後方向（見 TOKENOMICS.md）。

Router API：
```bash
# 睇自己餘額
curl http://<ROUTER_IP>:4900/credits/<node_id>
# 睇最近流水
curl http://<ROUTER_IP>:4900/ledger/latest?limit=10
# 睇全網節點
curl http://<ROUTER_IP>:4900/nodes
```

---

## 5. 私隱同安全（起碼知道個位）

- **私隱過濾器**（`notebook/privacy_filter.py`）：email/電話/IP/路徑/金額 + 自訂敏感詞，喺任務出網前遮罩。
- **沙盒**：遠端 executed 任務喺 Docker read-only container 入面；Phase 2 上 WASM。
- **語言自動三語**：Alert 訊息自動跟住你 terminal 語言（English/簡中/繁中）。

---

## 6. FAQ

| 問題 | 答 |
|------|----|
| 冇 GPU 可唔可以試？ | 得，`--mock` + `agent.json` mock=true |
| 會唔會影響我打機/工作？ | 個睡眠窗口同 `share_mode=off` 就係保護；你醒住即刻釋放 |
| 我部機嘅野會唔會俾人睇到？ | 唔會——沙盒 read-only + privfilter |
| 點先可以正式加入你哋網絡？ | `support@swarmai.club` 報名（早期節點）；或自己起自己嘅 swarm（上面 3 步） |
| 有無人已經用緊？ | 5 節點 Qwythos live，BBH-lite direct 50% → swarm 100% |

---

## 7. 支援

- Email：`support@swarmai.club`（或 `support@newalgotrade.online`）
- GitHub：`github.com/SwarmAI-Club/swarm-orch`（issue / PR welcome）
- 官網：`swarmai.club`

© newalgotrade.online · 開源 MIT · 人人有份