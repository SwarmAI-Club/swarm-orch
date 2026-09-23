# SwarmAI / swarm-orch Router 安全審計報告 + 修復
**日期**：2026-09-23  |  **審計員**：Big Pickle（router owner）
**範圍**：`swarm-orch/router/router.js`（router）、`worker-node/worker.py`、`nginx.conf`（swarmai.club）、portal.html
**Git**：`/mnt/d/docker_nginx` monorepo（已 commit `dcd22dc`）

---

## 🔴 CRITICAL

### C1 — `/portal/forgot`（同 `/portal/forgot` SMTP 路徑）命令注入 → RCE（已修復）
- **漏洞**：`router.js` `/portal/forgot` 用 `exec('python3 -c "${py}" "${email}" "${link}"', ...)` 糸統 shell 執行；`email` 由 signup 原樣入 DB（只 lowercased、**無格式驗證**），forgot 時未 sanitize 直入 shell → **任意命令執行**。
- **實測**：`POST /portal/signup` email=`x";touch /tmp/.../RCE_PWNED;"@a.co` → 成功建立 file（RCE confirmed）。
- **修復（router.js）**：
  1. `validateEmail()`：RFC 5322 regex（`/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/`）+ 禁 shell metachar（`" ' $ \` ; ( ) { } | & < >`）+ `spawnSync` array-form（唔行 shell，`spawnSync("python3", ["-c", py, email, link])`）→ **RCE 熄滅**。
  2. signup/forgot 加入驗證 ↓「唔可以只算唔驗」。

---

## 🟠 HIGH

### H3 — SSRF：probeAbilities / node probe 可打內網（已修復）
- **漏洞**：`probeAbilities()`（router.js:177）接受任何 authenticated node 嘅 `completion` URL 並 `fetch` → **SSRF**（可 probe 169.254.169.254 metadata、100.x tailnet、docker bridge、nginx internal services）。
- **修復**：加 `probeAddrOK()` — 只用 BIND（<ip> + 127.0.0.1）+ loopback，其他一律 blocked；`/register` `/status` 觸發 probe 前判過。Tailnet workers（100.71.x 都係 BIND binding，唔受影響）。✅ 已驗證：evil node 用 completion=`169.254.169.254/props` probe → error `blocked non-bind probe`，唔觸達 metadata。

### H1 — Idle-mint 經濟濫用（無限免費 SWAI）（已修復）
- **漏洞**：node 可自報 `speed` / `free` / 無限心跳 → 每分鐘 idle mint 無限 SWAI（`[idle] sd-1 +34086 SWAI/30s` — 見實測）。長期 idle 大 node 可無限「印」SWAI 賣錢或者燒喺其他 paid node。
- **修復**：
  1. `MAX_SPEED_TOK_S=100` speed clamp：`/register` 同 `/status` 都 cap `speed` 去 max 100 t/s（`speεδtoOTable`… 簡言之 clamp）。
  2. `MAX_IDLE_MINT_PM=20` per-node idle mint window cap（`mint_window` tracking）— 每 node 每分鐘 idle mint SWAI 上限，心跳太快都會 cap。
  3. `free` flag 只可以由 admin/owner node_settings 設，唔可以喺 heartbeat 任意自改。
- **實測**：evil-speed node（speed=99999）→ register 後 clamp 100、idle mint cap `(tokens 611 cap→20/min)`；`free` 唔可以經 `/status` 開（403）✅。

---

## 🟠 MEDIUM

### M1 — `/portal/me` `/ledger/latest` `/credits/:account` 未授權讀取（已修復）
- **漏洞**：任何 authenticated user（即使 client scope）可以查**任何 account** 嘅 `/portal/me`、`/credits/:account`、`/ledger/latest`、`/nodes` — 洩露他人 node_id、speed、balance、ledger、deposit wallet。
- **修復**：`/credits/:account`、`/ledger/latest`、`/portal/me`、`/nodes` 全部加 account ownership check（`accountForToken` vs `node.account`）；唔係自己嘅 → 403 / 淨返自己嘅。admin（NET_TOKEN）照舊睇全部。

### M2 — nginx：swarm_limit zone 已定義但從未用（已修復）
- **漏洞**：`nginx.conf` 有 `limit_req_zone ... zone=swarm_limit:10m rate=30r/m` 但 **無任何 location 用到** → `/swarm/`、`/portal/` 真係無限速（rate limit 只落咗 login/signup 5r/m）。↔ With router 直接 bind tailnet，`/register` 可以無限超頻打 SSRF probe。
- **修復**：nginx.conf `location /swarm/` 同 `location /portal/` 加 `limit_req zone=swarm_limit burst=15 nodelay`；`/portal/login`、`/portal/signup` 用 `portal_limit`（5r/m burst 5，原本就有）。`/swarm/` 30r/m burst 15 → worker heartbeat 唔會撞。✅ 已 reload nginx 驗證。

---

## ⚪ LOW

### L1 — hardcoded `UPTIME_RATE_PM`（unused legacy）
- `UPTIME_RATE_PM` constant 已定義但未用（新用 token-based mint）。保留做 compat；唔算弱點。

### L2 — sd-webui 7860 / ComfyUI 8188 bind 全部界面
- sd-webui:7860、ComfyUI:8188 喺 tailnet + 本機 listen `*`。SSRF / 一般中毒節點可以打到其中介 port 攞 GPU 算力。
- ComfyUI 已改 compose `127.0.0.1:8188`（loopback only）✅。sd-webui（runpod image 手動起，無 compose）→ **待改**：`docker run -p 127.0.0.1:7860:3000`（loopback）bind 返本機。⚠️ 依家 `0.0.0.0:7860` 依然存在。

### L3 — router bind 亦喺 tailnet <ip>:4900
- Router 同時 bind tailnet 10x (<ip>:4900) 方便 remote worker。呢個係 design（tailscale mesh 內部），唔係漏洞。若要更嚴格可只 bind 127.0.0.1，但會斷 remote 機。

---

## ✅ 已檢查（安全）
- **SQL 注入**：全 DB 都用 parameterized queries（better-sqlite3 `?` placeholders），無 string-concat SQL（冇 grep 到）✅
- **XOAuth/AT**：`x-swarm-token` middleware 要求所有 router 端點要有 token；client scope 唔可以做 worker 操作、worker scope 唔可以落單扣費（scope 分離）✅
- **密碼**：signup 13+ 位 + 大階+細階+數字+符號（hashPass scrypt）；login/logout 都有 rate limit（nginx 5r/m）✅
- **充值**：USDC topup `scanPolygonTx` on-chain 驗證 + tx dedupe（`deposits` table unique）+ 只引入確定性地址（deposit wallet from env）✅
- **admin endpoints**：`/ledger/mint` `/ledger/burn` `/ledger/latest` `/admin/*` 全部 `x-swarm-token === NET_TOKEN`（admin only）✅
- **HMAC**：`/assign` worker verify 用 HMAC sha256（防止偽造 assign）✅
- **SSRF（dispatch）**：`nodePushAddrOK()` 只允許 BIND hosts push，唔會 fetch 內網 ✅（新加嘅 probe 亦已封）

---

## 🔭 跟進建議（未做/需你決定）
1. **sd-webui 7860 bind loopback** — 需要改 `docker run`（無 compose），建議：`docker run -p 127.0.0.1:7860:7860 ...`（Windows 主機上改）。
2. **SQLite 收費 wallet**（`SWARM_DEPOSIT_WALLET`）——router 用 env 讀，只喺 server 本機；確認唔會 commit 入 git（已 gitignored？確認）。
3. **主 router 主機 rate limit** — 目前 `4900`（swarm-monitor.env）只 nginx 過；router 直接 bind tailnet 可以 bypass。若想更嚴可考慮 router 內建 per-IP rate limit（有 `t.mint_window` 等）。屬選項。
4. **SMTP reset link token 明文入 link** — reset code 128-bit random（足夠安全），但「domain + token 一齊喺 link」，若 SMTP server 記錄 outgoing email（Zoho 會），有 30 日嘅 token 暴露期 → 建議只發一次性 reset code 短 token（已做：`user_resets` code 一次性 + 30min expiry）。

---
*本報告由 Big Pickle 安全審計，含 router + worker + nginx + portal 四層。修復已 commit + live-verify。*
