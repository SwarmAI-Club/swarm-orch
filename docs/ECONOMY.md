# SWAI Economy v2 — 費率 / 歸戶 / 節點 / 貢獻（權威文件）

> 最後更新: 2026-09-18。呢個係「遺忘可查」嘅源頭文件。
> 相關 code: `swarm-orch/router/router.js`、`swarm-orch/worker-node/worker.py`、`swarm-orch/agent/swarm_agent.py`。

## 1. 核心費率（env 可調，router 讀）

| 參數 | env | 預設 | 意思 |
|---|---|---|---|
| 1 SWAI 基底 | `SWAI_TOKENS` | 10000 | 1 SWAI = 10,000 tokens 嘅概念基準 |
| 消耗 input | `SWAI_RATE_IN` | 5000 | 每 5,000 input tokens 扣 1 SWAI |
| 消耗 output | `SWAI_RATE_OUT` | 1000 | 每 1,000 output tokens 扣 1 SWAI（**貴 5x**） |
| idle 產能 | — | node.speed | 每分鐘 idle = node tok/s × 60 → tokens → 按 RATE_OUT 折算 mint |
| 預估上鈫 | — | task 內 | `est_in = prompt字數/3.5`、`est_out = n_votes×512` |

**兌換**：賺（idle/投票）同使（/task）**都係同一 account balance**，一體通行。
- 你部機越快（tok/s 高）→ idle 賺越快。
- 5 node 全用你 token 註冊 → 全部 mint 入**你同一個 account**（email）。

## 2. 歸戶規則（5 node → 1 account）

- `credits` 表 key = **account（email）**，唔再係 node_id。
- Worker 用 user API token 註冊 → `router` 用 `findUserByToken(token).email` 做 account → **所有 node 賺嘅合併入同一 email balance**。
- `accountForToken()`：NET_TOKEN → `^system^`；user token → `email`.
- 舊 node_id 制 data 保留喺 `credits_old`（未清，可手動 merge）。

## 3. Mint / Burn 流程

- **Idle（Proof-of-Uptime）**：worker 心跳 `IDLE_SHARING` → router 用「兩次心跳時差 × node.speed」計 tokens → `ledgerMint(account, tokensOut, kind='idle')`。
  例：rtx2060b（30 tok/s）idle 60s → 1800 tokens → 1800/1000 ≈ 2 SWAI/min。
- **投票（vote）**：worker `/result` 報 `tokens_in/tokens_out`（llama-server `/completion` 回報 `tokens_evaluated/tokens_predicted`）→ `/vote` 按 `tokensToCredit(in,out)` mint 入 **node.account**。
- **任務消耗（task）**：`/task` 先按**估計 tokens** `ledgerBurn`（防 spam），`/vote` 後按**實際 providers 收到嘅 credits** 精算，多退（`kind='refund'`）。
- **手動 mint/burn**：`/ledger/mint`、`/ledger/burn` 而家**只俾 admin（NET_TOKEN）**，普通 token 403。

## 4. 節點 ctx（全部升到 64K — 2026-09-18）

| Node | 服務 model | n_ctx | slots | 速度 tok/s | 啟動 script |
|---|---|---|---|---|---|
| main | qwythos-1m-main @:8087 | **65536** | 2 × 65536 | ~23 | `agent-core/llama-launch/main-8087.sh`（`--parallel 2 -c 131072`）|
| rtx2080ti | qwythos-1m @:8087 | **65536** | 1 | ~17 | `~/llama-8087.sh`（SSH ubuntu@100.106.211.51）|
| rtx3060 | qwythos-1m @:8080 | **65536** | 1 | ~30 | `~/llama-8080.sh`（SSH ubuntu@100.97.2.13）|
| rtx2060a | qwythos-1m @:8087 | **65536** | 1 | ~28 | `/opencode/llama-8087.sh`（wsl via marco@100.115.169.51）|
| rtx2060b | qwythos-1m @:8087 | **65536** | 1 | ~30 | `/opencode/llama-8087.sh`（wsl via marco@100.103.0.102）|
| main vision | qwen2.5-vl @:8090 | 32768 | 4 | — | desktop-agent /screenshot 用 |

> ⚠️ main 一定要 `-c 131072 --parallel 2` 先做到 2×65536；`-c 65536 --parallel 2` 只會得 32768×2。
> ⚠️ `--reasoning off` 對 main 好重要（令 `/v1/chat/completions` 返 content，MT5 AI Assistant 要）— `ensure-llama-8087.sh` 已有。

## 5. 用戶個人控制項

| 控制 | 機制 | 用法 |
|---|---|---|
| 睡眠窗口（idle 幾時） | `agent/swarm_agent.py` + `agent/agent.json` | 設 `sleep_start_hour/end_hour` + `timezone`；`python3 agent/swarm_agent.py --config agent/agent.json --heartbeat 30` |
| 速度（idle 賺幾快） | `--speed` | 手動填 tok/s；唔填就 worker 起機 auto-bench |
| 貢獻能力 | `--capabilities` | `reasoning math analysis code vision` 任揀，router 用 Jaccard 匹配 |
| 貢獻比率 | (`--share-ratio` 未實作) | 建議：idle 產能可日後按 % 折算 |

## 6. 例題

- rtx3060（30 tok/s）idle 1 日 1440min：30×60×1440 = 2.59M tokens → /1000 ≈ **2,592 SWAI/日**（單 node）。
- 5 node 平均 ~26 tok/s idle 一日 ≈ **~11,000 SWAI/日**。
- 一次 3-vote task（in 500 out 900）：500/5000 + 900/1000 = 0.1 + 0.9 = **1.0 SWAI**。
- 一次 2-vote 答「2+3」（上面實測）：in 36 out 128 → 36/5000 + 128/1000 ≈ 0.1+0.1 = 估費 ~1 SWAI，worker mint 每個 +1（實測：4 vote mint 各 +1，task burn 1）。
---

## 7. 定價 Tier / OpenAI Gateway / Vision / Pilot（2026-09-18 實作）

### 對外 model（OpenAI-compatible）
`POST /v1/chat/completions`（`Authorization: Bearer <token>`）
| model | 派去 | 收費 |
|---|---|---|
| `swarmai-fast` | tier S/A（5090/4090/2080Ti）| 貴（S×1.8 / A×1.3）|
| `swarmai-normal` | tier B/C（3060/2060/≤8GB）| 平（B×1.0 / C×0.6）|
| `swarmai-fast-vision` | qwen2.5-vl（自動，含 base64 image）| 純按 tokens |

- **tier 由 `gpu`/`vram` 判定**：S=5090/4090/≥24G · A=2080Ti/3090/≥20G · B=≥10G · C=其餘
- **fallback**：fast 冇 S/A → 派 B 但照收 normal 平價
- **分派**：`matchCapabilities × share_ratio × (快+rating)`
- `GET /v1/models` 列 model + n_votes/tiers metadata

### 評分 Grade（/portal/me 每 node）
`speed(50%) + availability(25%) + capacity(15%) + trust(10%)` → 0-100 → S(≥90)/A(≥80)/B(≥65)/C(≥50)/D

### Pilot 優惠
- `SWARM_SIGNUP_BONUS=50`：開戶即送 50 SWAI（`kind=manual`, note=welcome_bonus）
- `promotions` 表（discount/mint_boost）；`POST /admin/promo`（admin）建 code；`GET /portal/promos`
- Portal 頂橫幅顯示試玩 + code

### 安全（P2）
- `/assign` HMAC 簽名（router `SIGN(task_id::node_id)` 用 `SWARM_ROUTER_SECRET`；worker 驗）→ 直撳 /assign 403
- `/result` 驗「task 有派過俾呢個 node」（assigned set）→ 防偽造 vote 呃 SWAI
- `/tasks/poll` 鎖 node 歸屬（token account ≠ node account → 403）


## 8. Free Node（per-node 免費分享，2026-09-18）
- worker `--free` 或 portal `/portal/node_toggle`（owner）開關每個 node 嘅 free mode
- 全 free targets → 要求者**唔 burn**（est_fee=0）；Node owner **照收 mint**（善意分享，付出咗算力）
- mixed（有付費 node）→ 照正常收費（保守）
- `/v1` response 有 `free_served` 標記 + `est_fee`
- ⚠️ 自由環境有濫用風險；rating guard 部分緩解。揀 node 用 rating。

## 9. API 認證
- `Authorization: Bearer <token>` 或 `Bearer sk-swai-<token>`（`sk-` 只係 OpenAI 相容前綴，router 自動剝落）
- worker `--token` 同 `--router-secret` 必填（router 派工簽名用後者）
