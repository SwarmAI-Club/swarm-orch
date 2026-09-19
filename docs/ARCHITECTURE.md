# SwarmAI — 整體基建・安全・工作流・經濟・定價 權威藍圖（ARCHITECTURE）

> **用途**：Future validation & 程序基準。所有架構決策 / 端口 / 權限 / 安全層 / 工作流 / 經濟 v3 / 定價 Tier / Vision 分流 / Pilot 優惠 / 評分 / 監察指標一次過鎖死喺度。
> **紀律**：改動基建或經濟 → 必須同步更新本文件 + `ECONOMY.md`。最新改動日期：2026-09-19。
> 相關 code：`swarm-orch/router/router.js`、`swarm-orch/worker-node/worker.py`、`swarm-orch/agent/swarm_agent.py`。

## 核心理念（North Star — 社群憲章）

**SwarmAI 孕育信念 — 用家建立自己嘅 AI 互助網絡平台。**

用各自嘅 idle 時間，產生最大效益。就算不是最頂尖的 AI agent，只要用戶肯在現有的基礎發展落起，這個 SwarmAI Club 一定以健康正面維度發展，在量的方面發展下去，不斷升級，優化群組內的應用體驗，本著互助同理之心，向未來邁進。

🙌 呢句係平台嘅精神契約，超越任何單一功能：**每個人都係貢獻者**（idle 時間都係資產）**，每個人都係受惠者**（用群體算力升級自己），唔需要最強硬件先可以加入 —— **有心想砌，就係會員**。

**集體智能體願景（Collective Intelligence）**：未來群組會聚集更多**自由開發者**，以呢個平台作交流基地，齊手發展出更多**便利工具、智能體（agent）、自有 model**，俾一般大眾使用者直接用 —— 由「共享算力」進化到「共享智力」，形同一個**集體智能體**持續成長。平台角色：算力基建 + 工具市集 + 共創生態。

---

## 1. 實體基建（实测 2026-09-19）

```
[ main ] 100.70.76.100  (2x2080Ti 22GB, WSL2)  ← 私人主機，唔 share
 ├─ Router  :4900       (中央調度+分帳; bind 127.0.0.1 + 100.70.76.100)
 ├─ main worker → SUSPEND 佢（唔派工，mainpc 自用）
 ├─ qwen-vision → SUSPEND（唔 share；vision 由 rtx2080ti-vl 提供）
 └─ 你日常 AI 入口（portal/api/self-learning）

共享 node（4 部閒置機入網，vision-only-free）：
[ rtx2080ti ]  100.106.211.51  (22GB)   qwythos :8087 (非free) + qwen-vl :8089 (free, vision primary)
[ rtx2080ti-vl ] 100.106.211.51 :8089   Qwen2.5-VL 7B (free, capabilities=vision)
[ rtx3060   ]  100.97.2.13     (12GB)   qwythos :8080 (非free，唔serve vision)
[ rtx2060a  ]  100.97.18.72    (12GB)   qwythos :8087 (free + vision backup)
[ rtx2060b  ]  100.89.139.66   (12GB)   qwythos :8087 (free + vision backup)
```

### Vision-only-Free Policy（2026-09-19）
- **只有 free node 先 serve vision**：`rtx2080ti-vl`（Qwen-VL primary）+ `rtx2060a/b`（Qwythos mmproj backup）都係 free。
- `rtx3060` / `rtx2080ti`（非 free）**唔加 `vision` capability** → router 唔會派 vision 任務俾佢哋（`matchCapabilities` 見冇 cap → 唔揀）。
- 效果：任何用家 vision 任務都派去免費 nodes（唔扣 token，吸引試用）；text 照 economic 規則（free 活着 paid）。
- **Backup 鏈**：`rtx2080ti-vl`（高質 Qwen-VL）primary → 若冧，自動落 `rtx2060a/b`（Qwythos 帶 mmproj）。

### 啟動 scripts（權威，重啟唔失憶）
| Node | 啟動 | watchdog |
|---|---|---|
| main :8087 | `agent-core/llama-launch/main-8087.sh`（`-c 131072 --parallel 2 --reasoning off`）| cron `ensure-llama-8087.sh` 5min |
| rtx2080ti | `ssh ubuntu@100.106.211.51 ~/llama-8087.sh` | — |
| rtx2080ti-vl | `ssh ubuntu@100.106.211.51` 起 `/opt/models/qwen-vl/` `:8089`（`-c 8192 -ngl 99`）| worker 加 `rtx2080ti-vl`（free, vision）|
| rtx3060 | `ssh ubuntu@100.97.2.13 ~/llama-8080.sh` | `run-qwythos.sh` |
| rtx2060a | wsl `/opencode/llama-8087.sh` | — |
| rtx2060b | wsl `/opencode/llama-8087.sh` | — |

> ⚠️ main 一定要 `-c 131072 --parallel 2`（`--parallel N` 會分 ctx；`65536,2` = 32768×2）。
> ⚠️ 2060a/b 冇直接 WSL SSH → 經 `sshpass marco@100.115.169.51/100.103.0.102` + `wsl -d Ubuntu -u root -- sh -c`（多命令用 base64，防 cmd.exe 拆引號）。
> ⚠️ **Worker 起法 `agent-core/swarm-workers-start.sh`**：main + qwen-vision 兩行**保留但 SUSPEND**（`/portal/node_settings` suspend:true → router 唔派）；`rtx2080ti-vl` 加咗行（free vision）；2060a/b caps 有 `vision`；3060/2080ti cap 冇。

## 2. 角色 / 端口

| 角色 | 端口 | 對外 |
|---|---|---|
| Router API | 4900 | nginx `/swarm/` + `/portal/` via Cloudflare |
| Worker HTTP | 5900-5904 | 內網 only |
| LLM completion | 8087/8080 | ⚠️ 目前 0.0.0.0（P2 封網目標 127.0.0.1）|
| Desktop-agent | 5012/5011 | 內網 |
| Vision service | 5015 | 內網（TG bot 貼圖）|

## 3. 認證 & 權限（目標 v3 — 逐步落實）

- auth middleware：`NET_TOKEN`（server env `SWARM_API_TOKEN`）**或** DB `user_keys` token
- **user_keys.scope**（里程碑實作）：`client`（/task /v1，扣自己 balance）｜`worker`（register/status/poll/result）｜`admin`（ledger/nodes）
- `/ledger/mint|burn` 只俾 NET_TOKEN（admin），其餘 403

## 4. 主工作流

### 4.1 用戶 onboarding
```
signup → token + client-xxx → 起本地 llama (127.0.0.1:8080) → docker run swarm-worker --pull
→ /register → 心跳 30s → auto-bench speed → auto re-register (router 重啟自癒)
```
### 4.2 任務（推 vs 拉）
```
/task → matchCapabilities({cap → tier → rating → speed}) → LAN node POST /assign | NAT node inbox poll
worker → llm_complete ×n_votes → /result(tokens_in/out, duration_ms) → /vote 加權 majority → winner
```
### 4.3 經濟 v3
```
mint = (idle_min × 2 SWAI/min  [Base 底薪, 同級]
      + output_bonus)           [完成單數 + 質量, 真做嘢先有]
      × hardware_mult × rating_mult
費率：1 SWAI = 10K tokens；in 5000t / out 1000t（output 貴 5x）
歸戶：credits key = account(email)；5 node 全入同一 email
```
### 4.4 監察
```
swarm_monitor.py：nodes≥5 + backend /props ctx≥65536 + /health
swarm-node-heal.sh：backend down → remote restart（cron 5min）
```

## 5. 定價 / Tier / 分流（2026-09-18 鎖定）

### 對外 Logical model（用戶見到）
| Logical model | 派去 | 收費 | 備註 |
|---|---|---|---|
| `swarmai-fast` | tier S/A（5090/4090/2080Ti）+ 任 free node | 貴 S×1.8 / A×1.3 | 高 grade 優先 |
| `swarmai-normal` | tier B/C + 任 free node | 平 B×1.0 / C×0.6 | 高 grade 優先 |
| `swarmai-free` | 只 free node | **免費（唔 burn）** | 無 free node → 503 |
| `swarmai-vision`（隱藏）| qwen2.5-vl | 純按 tokens | 自動分流，唔對外列 |

- **tier 表**：S=5090/4090（×1.8 收費，mint ×1.8）· A=2080Ti/3090（×1.3）· B=3060/2060 12G（×1.0）· C=≤8GB（×0.6 收費 / ×0.7 mint）
- **fallback**：`swarmai-fast` 冇 S/A 機 → fallback B 但**照收 normal 平價**
- **排序**：`matchCapabilities` score（= 能力 Jaccard × share_ratio × rating）為主，speed 做 tiebreak — 高 grade 優先
- **free 混入**：fast/normal 嘅 candidates 一定含 free node；targets 有任一個 free → `free_served:true` = 免費
- **Vision 分流**：detect `image_url`/`data:image/` → 自動 `swarmai-vision`（隱藏），純按 tokens，image ≤4MB
- **/v1/models** 只列 fast/normal/free（vision 隱藏）

### LLM abilities 探測（profile 顯示）
- worker 註冊帶 `completion` URL → router probe `/props` `chat_template_caps` + `modalities`
- 得出 `tools / thinking / vision / ctx` 存入 registry + `/portal/me` nodes + portal「Abilities」欄（🔧🧠👁）

## 5b. 消費側 promo（coupon）
- **兌換型（reward）**：`POST /portal/redeem {code}` → 即時加 token 入 account（`kind=reward`）
  - **每人一次**（`promo_uses(email,code)`）· **週期**（valid_from/to）· **總次數上限**（max_uses）
  - 例：`WELCOME50` = +50 SWAI，每人一次，至 2026-12-31
- 消費折扣型：`applyPromoToFee`（`X-Swarm-Promo` header 或 body.promo）折扣 burn（舊機制，兩者並存）

## 6. Pilot 優惠（Phase 1 target）
- 開戶送 **50 SWAI** 試玩（`SIGNUP_BONUS`）+ coupon 兌換（WELCOME50 等）
- `promotions` 表（discount / reward）+ `/admin/promo`（admin 建）
- Portal 顯示 promo 橫幅 + 兌換輸入框
- seasonal 重玩法 → 有一定用戶後嘅 milestone

## 7. 評分（Rating）— P3
```
5 維（Accuracy beta 未加權）：speed(25) availability(20) capacity(10) trust(10) accuracy(beta 35)
score 0-100 → Grade S/A/B/C/D；每 node registry + profile 顯示
mint mult = 0.75 + rating/100×0.5；派工 sort 乘 rating
```

## 8. 監察指標（baseline）
- `/nodes` ≥5	・每 node speed 填值	・ctx ≥65536	・每 port **1** worker（防 duplicate）・ledger 有 idle/vote/burn

## 9. Phase 驗收單
| Phase | 內容 | 驗收 |
|---|---|---|
| P0 | 基建收口：2060a/b worker、清 duplicate、launcher 防重 | ✅ /nodes=5-6 每 port 1 |
| P1 | /v1/models + /v1/chat + MODEL_MAP + tier 收費 | ✅ (2026-09-18 實測) |
| P1b | image detect → vision route + image_data | ✅ 自動 swarmai-vision（隱藏）純 tokens |
| P2 | /result 驗 node、poll 鎖 node、assign HMAC auth 封網 | ✅ 403 verified；封網 pending |
| P3 | Profile 完整 + Grade + rating 入派工 + abilities | ✅ Grade S/A/B/C + dispatch weighted + tools/thinking/vision |
| P4 | 送分 50 + coupon 兌換（reward 每人一次）+ banner | ✅ /portal/redeem、WELCOME50、Square |
| P5 | docker bridge + host.docker.internal + nvidia-smi tier | ✅ bridge+host-gateway+pull；nvidia-smi pending |
| P6 | opencode-telegram 接入 SwarmAI 3 model | ✅ provider=swarmai 喺 opencode.json，/model 切換 |

## 11. opencode-telegram 接入 SwarmAI（P6，2026-09-18）
- `opencode.json` 新增 **`provider.swarmai`**（`@ai-sdk/openai-compatible`，baseURL `https://swarmai.club/swarm/v1`，apiKey = 主人 SWAI token `swai-7145...`）
- models：`swarmai-fast` / `swarmai-normal` / `swarmai-free`
- `opencode-telegram-bot/.env` default：`OPENCODE_MODEL_PROVIDER=swarmai`、`OPENCODE_MODEL_ID=swarmai-fast`
- Telegram `/model swarmai-fast|normal|free` 切換測試；API key 會扣主人 account `smarcoytst6@gmail.com` balance

## 10. 已知限制 / 將來（milestone）
- Accuracy 需要「驗證任務」先可靠（confidence 而家 worker 硬填 0.9）
- llama-server 未有加密 proof-of-work（attestation 太複雜；現行用「實測 speed/ctx + 驗證任務抽查 + 信心分」嚟防呃）
- idle 免驗真idle → 可能過度申報（時區/法規驗係將來）
- HA router 未有（單點中央 router；每日 snapshot 備份 ledger.db）

## 10b. Specialty Service 擴展（2026-09-19）— SD-WebUI / Wan / TTS 等非 text LLM（已實作 v1）
- **原則：普通用戶安裝一律 text model（Qwythos 等），零選擇**；specialty 由平台自家節點 + 進階用戶選配提供，唔計入一般用戶必修，避免用戶比例失衡。
- **已實作（2026-09-19）**：
  - `MODEL_MAP` 加 `swarmai-image`（cap `image-gen`，unitPrice 20 SWAI/job，max_units 4）同 `swarmai-video`（cap `video-gen`，unitPrice 80，max_units 8）；`/v1/models` 自動揭露，唔使改 gateway。
  - `/v1/images/generations`（OpenAI 相容）：`{model, prompt, n, size}` → 揀單一 `image-gen` node（matchCapabilities）→ 派工（push/pull）→ 等結果（180s）→ 收 `b64_json` → **unit 計費**：用戶 `ledgerBurnChecked`（壓力 daily quota），worker `ledgerMint` units×unitPrice。
  - **ledger 加 `units` 欄**；`ledgerMint` 支援 `{units, unitPrice}`（units>0 優先代替 tokens 折算）。
  - **Worker adapter 框架**（worker.py）：`--adapter image|video` + `--capabilities image-gen/video-gen`；`on_assign` 見 body `adapter` 就行 `on_adapter()`（唔行 CoT/llm）。內建 `adapter_image()` call SD-WebUI `/sdapi/v1/txt2img`（`SD_API_URL`），每張＝1 unit 回 `images:[data_uri]`；`adapter_video()` 係 Wan stub（`WAN_API_URL` 未實作）。`--completion` 對 adapter 嚟講係 SD/ComfyUI API 址（唔一定 llama-server）。
- **新增 specialty worker 上手**：`python3 worker-node/worker.py --router https://swarmai.club/swarm --token <T> --node-id sd-1 --capabilities image-gen --adapter image --completion http://127.0.0.1:7860/sdapi/v1 --pull --heartbeat 30`（SD-WebUI 已起）。用 `swarmai-image` model 落單即接到。
- **計費語義**：text/vision 照 token（`RATE_IN 5000`/`RATE_OUT 1000`）；specialty 照 **units×unitPrice**（每 job 計，唔係 token）。image/video 收費幾貴由 `SWAI_IMAGE_UNIT_PRICE` / `SWAI_VIDEO_UNIT_PRICE` env 控制。

## 10d. 自己機優先經濟 + USDC 充值（2026-09-19 實作）
- **自己機優先（dispatch_pref）**：`users.dispatch_pref` = `self`（default，自己機 available 就派自己）| `fastest`（唔理自己優先）| `free-first`（自己＋free 一併優先）。`matchCapabilities` 收到 `reqAcc`：自己 account 嘅 node score ×1.5。
- **收費三層**：① 全部自己機 → `self` 唔 burn；② 有 free node 參與 → `free` 唔 burn；③ 出面機 → `paid` burn（tokens/units×tier）。balance 或 quota 唔夠 → **fallback 落自己機＋free node（免費照做）**，response 帶 `mode:"fallback"` + notice；真冇先 402/429。
- **API 顯示**：`/v1/chat`、`/task`、`/v1/images` response 加 `mode`（self/paid/fallback/free）+ `notice`；`/portal/me` 有 `dispatch:{pref,mode,notice}` + `topup:{wallet,rate,min}`。
- **離線偵測**：`nodeOnline()`（>5min 冇心跳 = offline）；`matchCapabilities` filter offline；`/portal/me` nodes 帶 `online` + `last_seen_min`。唔 auto-purge（portal 手動移除）。
- **USDC on Polygon 充值**：`deposits` 表；`/portal/topup` 顯示收款地址（`SWARM_DEPOSIT_WALLET`）+ 兌換率（`SWAI_USDC_RATE` default 100）；`/portal/topup/submit` 提交 tx → `scanPolygonTx`（`eth_getTransactionReceipt` 掃 USDC `Transfer` event，`POLYGON_USDC` contract）→ confirmations ≥1 且 amount≥`MIN_USDC_TOPUP`(5) → `ledgerMint` kind=`deposit`。MVP 用 public RPC（`POLYGON_RPC`）。

## 10g. 安全模型（2026-09-19 pre-pilot audit）
- **SSRF 修復（重要）**：router 只會 `push`（主動 fetch）去**本機 BIND hosts**（`nodePushAddrOK`: host ∈ [127.0.0.1, 100.70.76.100]）；其他 url 一律 `--pull` inbox queue（worker 自己 poll）。**外部 user 註冊 node 一律強制 `pull=true`**（唔可以令 router 代打內網/其他節點）。`/beacon` 同有咁樣 filter。
- **認證**：所有非 `/portal` endpoint 要 `X-Swarm-Token`（冇 token → 401；fake token → 401）。`/ledger/mint|burn`、`/admin/*` 只接受 NET_TOKEN（普通 user → 403）。
- **防偽**：`/assign` HMAC 簽名（`SWARM_ROUTER_SECRET`）、`/result` verified assigned-set、`/tasks/poll` 鎖 node 歸屬。
- **pre-pilot scan 結果（2026-09-19）**：未認證/fake-token/USER撞admin 全部 401/403 ✅；SSRF 外部 node force pull ✅；install flow self-test 8/8 PASS ✅。

## 10e. Vision-Only-Free + rtx2080ti-vl（2026-09-19）
- **主機私有**：main (`main` + `qwen-vision` workers) → **SUSPEND**（唔派工、唔 share、一鍵可還原）。mainpc 只做 Router + 私人服務。
- **vision 免費通道**：只有 free node 有 `vision` capability → router 只派 vision 去: `rtx2080ti-vl`(Qwen-VL :8089, primary) + `rtx2060a/b`(Qwythos mmproj, backup)。非 free node（rtx3060/rtx2080ti）冇 vision cap → 唔 serve。
- `rtx2080ti-vl` worker：cap `vision`、free:true、port 5906、main 起，`agent-core/swarm-workers-start.sh` NODES 有。
- ⚠️ Vision 若 2080ti 冧 → 自動落 2060a/b（一般質素）；若成個機網冇 vision node → 503（牌）。

## 10f. 集體智能 Learn-Study（2026-09-19）
- 實驗證明「數量取勝」：`benchmarks/run_quantity.py` — 12 條 BBH+AMC 標準題 × 5 strategies（direct / majority / self-consistency / divergent / verifier）。
- **結果**：majority(11/12) = self-consistency(11/12) > direct(10/12) > verifier(8/12) > divergent(7/12)。
- **結論**：learn-agent 難題用 **self-consistency**（同機抖 temp 3 次攞 majority）最經濟提升準確率；唔建議 divergent（強迫方法反跌）／same-node verifier（驗證唔夠客觀）。
- 詳見 `docs/QUANTITY_LEARN_STUDY.md`。

## 10c. 用戶私隱（2026-09-19 起明列保證）
- **Data minimization（默認唔留）**：任務 prompt / AI 輸出結果**唔寫落任何 DB**（`ledger.db` 只有 users/credits/ledger/node_settings/daily_usage 等營運數據，冇任務內容表）。Router 處理過程用 in-memory `resultsStore`，結算完成後自動清（10min sweep），router restart 即全部消失。
- **Log 淨係營運 metadata**：router log 只記錄 node_id / model / units / 派工結果，**唔含 prompt / 答案內容**（2026-09-19 審查 + 移除 `[img]` prompt head 洩漏）。worker log 唔含 prompt。
- **唔賣 / 唔分享**：全 code open，冇任何 analytics/telemetry/第三方 call 發送用戶數據；冇數據留存 = 冇得賣、冇得洩。
- **帳戶級數據**：email（登入用）+ SWAI 餘額 + node 設定，只喺你自己 account 內可見（/portal/me 用你 token 認返你自己）。password 用 scrypt hash，冇明文。
- **承諾邊界**：記數（tokens/units/credit）係營運必需，保留；**任務內容係 ephemeral，平台唔保存、唔分析、唔分享**。社群版可喺 bot `/privacy` 顯示呢份保證。
- **Worker 側原則**：specialty worker 同 router 一律用 `/assign`+`/result`（HMAC 簽名 + assigned-set 防偽）對接，被 adapter 只係「completion 換成圖/視訊 API」。sandbox Dockerfile 加 `--gpus` + 額外依賴即可。
- **Vision（2026-09-19 更新）**：`qwen-vision`（main :8090）已 SUSPEND（main 私有）；vision 由 `rtx2080ti-vl`（Qwen2.5-VL :8089, free）提供 + 2060a/b（Qwythos mmproj）backup，全部 free。see §10e.
- **節點設定分層（2026-09-19 起）**：user-level（`users` 表）：display_name / pref_model / timezone / sleep 窗口 / share_default / max_budget_per_task；**node-level（`node_settings` 表）**：free / sleep_start_hour / sleep_end_hour / share_ratio / suspend / removed —— node 有設就覆寫 user 預設（`nodeShareOverride` / `nodeSuspended` / `nodeRemoved`），portal `/portal/node_settings` 逐 node 設定。