# SwarmAI — 整體基建・安全・工作流・經濟・定價 權威藍圖（ARCHITECTURE）

> **用途**：Future validation & 程序基準。所有架構決策 / 端口 / 權限 / 安全層 / 工作流 / 經濟 v3 / 定價 Tier / Vision 分流 / Pilot 優惠 / 評分 / 監察指標一次過鎖死喺度。
> **紀律**：改動基建或經濟 → 必須同步更新本文件 + `ECONOMY.md`。最新改動日期：2026-09-18。
> 相關 code：`swarm-orch/router/router.js`、`swarm-orch/worker-node/worker.py`、`swarm-orch/agent/swarm_agent.py`。

---

## 1. 實體基建（实测 2026-09-18）

```
[ main ] 100.70.76.100  (2x2080Ti 22GB, WSL2)
 ├─ Router  :4900       (中央調度+分帳; bind 127.0.0.1 + 100.70.76.100)
 ├─ Worker ×5 :5900-5904 (agent 代理, 全喺 main 行)
 ├─ qwythos :8087        ctx 65536 ×2 slots  --reasoning off
 └─ qwen-vl :8090        ctx 32768 (vision, 4 slots)

[ rtx2080ti ]  100.106.211.51  (22GB)   qwythos :8087  ctx 65536    + qwen-vl :8089
[ rtx3060   ]  100.97.2.13     (12GB)   qwythos :8080  ctx 65536
[ rtx2060a  ]  100.97.18.72    (12GB)   qwythos :8087  ctx 65536    (經 Windows wsl)
[ rtx2060b  ]  100.89.139.66   (12GB)   qwythos :8087  ctx 65536    (經 Windows wsl)
[ contabo   ]  100.99.14.67 / 2.58.82.219   emerge :8085  ctx 2048   (CPU, 唔入主網)
```

### 啟動 scripts（權威，重啟唔失憶）
| Node | 啟動 | watchdog |
|---|---|---|
| main :8087 | `agent-core/llama-launch/main-8087.sh`（`-c 131072 --parallel 2 --reasoning off`）| cron `ensure-llama-8087.sh` 5min |
| rtx2080ti | `ssh ubuntu@100.106.211.51 ~/llama-8087.sh` | — |
| rtx3060 | `ssh ubuntu@100.97.2.13 ~/llama-8080.sh` | `run-qwythos.sh` |
| rtx2060a | wsl `/opencode/llama-8087.sh` | — |
| rtx2060b | wsl `/opencode/llama-8087.sh` | — |

> ⚠️ main 一定要 `-c 131072 --parallel 2`（`--parallel N` 會分 ctx；`65536,2` = 32768×2）。
> ⚠️ 2060a/b 冇直接 WSL SSH → 經 `sshpass marco@100.115.169.51/100.103.0.102` + `wsl -d Ubuntu -u root -- sh -c`（多命令用 base64，防 cmd.exe 拆引號）。

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

| Logical model | 派去 | 收費 |
|---|---|---|
| `swarmai-fast` | tier S/A（5090/4090/2080Ti）| 貴 S×1.8 / A×1.3 |
| `swarmai-normal` | tier B 以下（3060/2060/≤8GB）| 平 B×1.0 / C×0.6 |
| `swarmai-fast-vision` | qwen2.5-vl | 純按 tokens |

- **tier 表**：S=5090/4090（×1.8 files→1.8 mint）· A=2080Ti/3090（×1.3）· B=3060/2060 12G（×1.0）· C=≤8GB（×0.6 收費 / ×0.7 mint）
- **fallback**：`swarmai-fast` 冇 S/A 機 → fallback B 但**照收 normal 平價**
- **排序**：快 + rating 高優先
- **Vision 分流**：detect `image_url` / `data:image/` → 自動 model=`swarmai-fast-vision`，純按 tokens 收費（唔另收），image ≤4MB cap

## 6. Pilot 優惠（Phase 1 target）
- 開戶送 **50 SWAI** 試玩（「pilot 試玩額」）
- `promotions` 表 + 邀請 code（discount / mint_boost）
- Portal 顯示 promo 橫幅
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
| P1b | image detect → vision route + image_data | ✅ 自動 swarmai-fast-vision 純 tokens |
| P2 | /result 驗 node、poll 鎖 node、assign HMAC auth 封網 | ✅ 403 verified；封網 pending |
| P3 | Profile 完整 + Grade + rating | ✅ Grade S/A/B/C + tier/ctx display |
| P4 | 送分 50 + promo + 邀請 code | ✅ 開戶送 50、/admin/promo、banner |
| P5 | docker bridge + host.docker.internal + nvidia-smi tier | ✅ bridge+host-gateway+pull；nvidia-smi pending |

## 10. 已知限制 / 將來（milestone）
- Accuracy 需要「驗證任務」先可靠（confidence 而家 worker 硬填 0.9）
- llama-server 未有加密 proof-of-work（attestation 太複雜；現行用「實測 speed/ctx + 驗證任務抽查 + 信心分」嚟防呃）
- idle 免驗真idle → 可能過度申報（時區/法規驗係將來）
- HA router 未有（單點中央 router；每日 snapshot 備份 ledger.db）