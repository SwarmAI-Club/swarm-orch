# 🤖 SwarmAI Telegram 自動客服

Long-poll Telegram bot，無需 framework（stdlib + requests）。FAQ 自動回、可查餘額/狀態、升級真人。

## 命令
| Command / 關鍵字 | 做咩 |
|---|---|
| /start /help /faq | 功能表 |
| 開戶 / 註冊 / account | Portal 開戶步驟 |
| 安裝 / install / docker | Worker 安裝（含 --pull） |
| token / api key | Token 點攞/點填 |
| 點數 / swai / balance | 點數機制 ＋ `私隱`：`/balance <你嘅API token>` 只睇自己；admin（SWARM_ADMIN_CHAT）先可任查 `/balance <node>` |
| 使用 / 落單 / task / use | API 落單例 |
| 狀態 / status | Swarm 網絡狀態（live /nodes） |
| 私隱 / 沙盒 / privacy | 私隱/沙盒說明 |
| /human / 人工 | 轉真人＋通知 admin chat |
| 其他 | keyword 分唔到 → 升級真人 |
| 撳 inline button / callback | ✅ 而家都處理（callback_query 當指令） |

## 部署
- 檔：`agent-core/swarm_support_bot.py`（main node）
- Task：Windows `swarm-support-bot`（/sc onstart）+ 可手動 `setsid python3 -u ... &`
- log：`/mnt/d/node-log/swarm-support-bot.log`
- 用 router 真實狀態：`swarm-monitor.env` 入面 `SWARM_ROUTER_TOKEN`（monitor 有）

## 專屬 bot token（建議）
而家 fallback 用 `.docker-watchdog.env` 嘅 `TELEGRAM_BOT_TOKEN`（opencode bot）。**建議用 BotFather 開一個專屬 bot**：
1. Telegram 開 @BotFather → /newbot → 抄個 token
2. 入 `swarm-support-bot.env`：
   ```
   SWARM_SUPPORT_BOT_TOKEN=<new token>
   SWARM_ADMIN_CHAT=<admin chat id>
   ```
3. 重啟 bot（kill 舊 process + re-launch）

> ✅ 2026-09-17: 已改用 **專屬 token**（@SwarmAI_Club_bot）＋ **flock 單一 instance 保證**（任何 respawner 都起唔到第二隻）＋ admin 通知包含**客戶名稱**（first_name/username）；code **只讀 `SWARM_SUPPORT_BOT_TOKEN`**（唔再 fallback 去 opencode token），並有 **409 startup guard** —— 唔會再同 opencode-telegram 搶。
