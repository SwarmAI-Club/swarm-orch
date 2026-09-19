# SWAI Token — Tokenomics（Discussion Draft v0.1, 2026-09-17）

> 策略定案：**概念上全 Token，但暫唔上鏈** — 用 SWAI token 單位做 off-chain 分帳，
> on-chain 遷移係長遠方向（先於 blog/roadmap 講，唔好急）。

## 1. 定位
- **貢獻 = SWAI**：Proof-of-Uptime + 完成任務投票 → mint SWAI 單位。
- **用 AI = 扣 SWAI**：呼叫其他時區 idle GPU 按 GPU-min 計算扣款。
- 自己機優先（免費），唔扣。
- 而家係 **off-chain settlement**（router 內 SQLite ledger，單位叫 `SWAI`）。

## 2. Mint / Burn 規則（off-chain，已實現）— v2 token-based（2026-09-19）
> 詳見 `docs/ECONOMY.md` §1-3。舊 GPU-min 制已換成 **token-based**：
- **Mint**：
  - Idle（Proof-of-Uptime）：兩次 `IDLE_SHARING` 心跳 × node.speed → tokens → `RATE_OUT`(1000 tok/SWAI) 折算。
  - Task vote：provider 按實際 `tokens_in/out`（`RATE_IN` 5000 / `RATE_OUT` 1000）。
  - Specialty（image/video）：`units × unitPrice`。
  - **USDC 充值**（2026-09-19）：`deposits` 表；1 USDC = 100 SWAI。
- **Burn**：/task 先按估算 tokens burn（防 spam），/vote 後精算退款；每日有 quota（2000/d）。
- **自己機優先（2026-09-19）**：自己 account 機 → 唔扣；balance 唔夠自動 fallback 自己機+free machine（唔硬 402）。
- 抑制 spam：細任務至少 1 SWAI（可日後改比例上限）。

## 3. 供應與通脹（建議值，未定案）
- 初始供應：0（全 mint 制，無 pre-mine）；或者設創世池（生態/開發）。
- 每單位價值錨定：1 SWAI ≈ 1 GPU-min 嘅最低成本（對比雲端 0.1x 定價）→ 唔好喺 off-chain 階段畀市場炒賣預期。
- 上限：可設硬 cap（例如 1B）或 float；**未定案，先寫低等社群討論**。

## 4. on-chain 遷移（未來 Phase，唔好而家做）
- 路線：L2（Base/Arbitrum）或 Solana SPL —— 未揀死。
- 問題要解決：
  - per-task mint 上鏈太貴太慢 → 用 **batch settlement / checkpoint**（off-chain 累積 500+ SWAI 先結算一筆）。
  - 錢包身份 ↔ 節點 ID 綁定（簽章 proof）。
  - KYC/監管：保持「實用型積分」定位，避免 securities 定性。
- 未做之前：blog/ROADMAP 寫住「SWAI token 長遠 on-chain」就夠。

## 5. 敘事
- 「瞓覺就賺 SWAI，醒來成個網絡幫你算。」
- 網頁講「挖點數」→ 改「賺 SWAI（token 單位，先 off-chain）」。
## 6. **Economy v2（2026-09-18 定案）— token-based**
> 詳見 `docs/ECONOMY.md`。重點：
> - **1 SWAI = 10,000 tokens** 基底；消耗 input `5000t/SWAI`、output `1000t/SWAI`（output 貴 5x）。
> - **歸戶**：`credits` key 由 node_id → **account(email)**；5 node 用同一 token 全部 mint 入同一 email balance。
> - **idle 入帳**：兩次 `IDLE_SHARING` 心跳時差 × node.speed → tokens → mint（修返以前唔入帳 bug）。
> - **/task 估費 + /vote 精算退款**；`/ledger/mint|burn` 只俾 admin。
> - 例子：跑 5 node idle 1 日 ≈ 11,000 SWAI；一次 task ≈ 0.1–1 SWAI。
