# SWAI Token — Tokenomics（Discussion Draft v0.1, 2026-09-17）

> 策略定案：**概念上全 Token，但暫唔上鏈** — 用 SWAI token 單位做 off-chain 分帳，
> on-chain 遷移係長遠方向（先於 blog/roadmap 講，唔好急）。

## 1. 定位
- **貢獻 = SWAI**：Proof-of-Uptime + 完成任務投票 → mint SWAI 單位。
- **用 AI = 扣 SWAI**：呼叫其他時區 idle GPU 按 GPU-min 計算扣款。
- 自己機優先（免費），唔扣。
- 而家係 **off-chain settlement**（router 內 SQLite ledger，單位叫 `SWAI`）。

## 2. Mint / Burn 規則（off-chain，已實現）
- Mint：`credit = max(1, round(gpu_min × RATE))`，RATE 現時 env `SWARM_CREDIT_RATE_PM = 10 SWAI/min`。
- /vote 完成任務自動 mint 俾每個 provider（按 `duration_ms`）。
- Burn：requester 提交任務扣 SWAI；餘額唔足會 clamp，唔會負數。
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