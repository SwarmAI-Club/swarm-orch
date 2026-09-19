# SwarmAI Learn-Study — 「數量取勝」策略對比（2026-09-19）

> 目的：驗證「用數量（多 agent / 多 sample / 多路線 / 驗證）能否提升 AI 解難準確率」。
> 完整報告：`benchmarks/report_quantity.html`（Chart.js 圖 + 每題細表，中英雙語）。
> 工具：`benchmarks/run_quantity.py`（`python3 run_quantity.py --token <tok> --samples 3`）。

## 實驗設計
- **題庫**：12 條標準化題（BBH 推理多選 + AMC 數學風格），全部有 ground truth。
- **通道**：`/v1/chat/completions`（Swarm 網絡，`swarmai-free`/`swarmai-normal`；用自己 account + free node → 唔扣 token）。
- **5 策略 × 每題 3 samples**：

| 代號 | 策略 | 數量維度 | 做法 |
|------|------|---------|------|
| A | Direct | — | 單 node 單答（baseline）|
| B | Majority | 機器數 | 多 model / 多 node 各答一次 → 多數決 |
| C | Self-consistency | 時間數 | 同一題問 3 次（抖 temperature）→ 最高頻 |
| D | Divergent | 角度數 | 3 種指定解法提示 → 多數決 |
| E | Verifier | 驗證閘 | 產生答案群 → 同一 node 獨立 session 揀 best |

## 結果（12 題準確率）

| 策略 | 準確率 | 結論 |
|------|--------|------|
| **A Direct** | **10/12 (83%)** | baseline |
| **B Majority** | **11/12 (92%)** | ✅ 數量（多機）取勝 |
| **C Self-consistency** | **11/12 (92%)** | ✅ 數量（抖樣本）取勝 — 唔使借機 |
| D Divergent | 7/12 (58%) | ❌ 逼指定路線反而跌 |
| E Verifier | 8/12 (67%) | ❌ 驗證員未好過答題者 |

## 結論

1. **「數量」真係幫到手，但係「多答案 → 揀多數決」嗰種**：B（多機）同 C（同機抖樣本）都 92%，勝過單答 83%。
2. **最經濟嘅取勝法 = Self-consistency（C）**：唔使借網絡其他機，一部機抖 temperature 問 3 次攞 majority 就 +1 準確率 → **推薦 learn-agent 採用**。
3. **Divergent（多路線 prompt）唔掂**：強迫 model 用指定方法反而亂（58%）。原因：Qwythos 對「用 X 方法」提示未必配合。
4. **Same-node Verifier 一般**（67%）：同一 Qwythos 做齋驗唔夠客觀（冇 reference answer 喇）。若果有獨立更強 model（e.g. Qwen-VL / 更大 model）做 verifier，可能更好 — 後續可試。

## Learn-Agent 建議（rtx2080ti 自學）

- **難題處理**：`ask_llm()` 加 self-consistency fallback（同一題抖 3 次 temperature → 選擇最高頻）→ 直接提升數學/推理準確率（10→11/12 效果於學習資料）。
- 唔需要為咗準確而加 Divergent / Verifier（除非日後有獨立強 model 做 critic）。
- 這個實驗證明：**「數量」喺資源充足嘅社群網絡係免費資產** — 自己機抖 sample 唔扣 token，但換到 +9%準確。

## Files
- `benchmarks/run_quantity.py` — 實驗 runner
- `benchmarks/report_quantity.html` — 圖表報告（中英）
- `benchmarks/results/quantity_<ts>.json` — raw 結果