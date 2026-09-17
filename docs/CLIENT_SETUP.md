# Client Setup — 用戶點連接（Docker / Worker）

> 新用戶想借 GPU 入 SwarmAI 三步搞掂。

## 0) 三樣要填嘅嘢
| 填啲咩 | 值 |
|---|---|
| **Router API 地址** | `https://swarmai.club/swarm/`（443 主入口，Cloudflare，要開任何 port） |
| **API token** | `https://swarmai.club/portal/` → Sign up → 登入後攞你條 `X-Swarm-Token` |
| **node_id** | Portal 顯示嘅 `client-xxx`（身份 + SWAI 入帳） |

Optional 稀有 port：`http://swarmai.club:6769/`（繞 Cloudflare，但要 router forward `TCP 6769` 去你部機）。

## 1) Docker 連接（NAT 後都 Work — Pull Mode）
Container **淨係要 outbound** 去上面 API 地址；router 唔會打返入你 → 任何 NAT/firewall 後都得。

```bash
# 起你部機模型 (llama.cpp)
./llama-server -m /path/to/Qwythos-9B-....gguf --host 127.0.0.1 --port 8080 -ngl 99 -c 32768

# build worker image
cd swarm-orch && docker build -f sandbox/Dockerfile -t swarm-worker .

# PULL mode（只出 outbound）
docker run -d --name swarm-worker \
  -e SWARM_ROUTER="https://swarmai.club/swarm" \
  -e SWARM_API_TOKEN="<token>" \
  -e SWARM_COMPLETION="http://host.docker.internal:8080/completion" \
  -e SWARM_MODEL="qwythos-1m" -e SWARM_GPU="RTX 4080 16GB" \
  swarm-worker python worker.py \
    --router "https://swarmai.club/swarm" --token "$SWARM_API_TOKEN" \
    --completion "$SWARM_COMPLETION" --node-id "<client-xxx>" \
    --capabilities reasoning math code --pull --heartbeat 30
```

- `--pull`：work 用 （3s）poll `/tasks/poll` 攞任務，唔使開 inbound。
- LAN 直連想被 push：唔加 `--pull`，但 router 要摸到你部機 `/assign`（port 要出街）。

## 2) 點分流（Routing）
1. 客戶 `POST /task` → Router
2. Router 用 **capability matching (Jaccard)** 揀 node + score 排優先
3. LAN push node → Router 直打 `/assign`；NAT pull node → 放 inbox 等佢 poll
4. 每個 node 跑 votes → `POST /result`（填 duration_ms）
5. Router `/vote` 加權 majority → 答案
6. Provider 按 `gpu_min × 10` mint SWAI（自動）
7. 失聯 node → failed 列表 skip，唔 block 成個 task

愈多 node 投票愈準（實測 direct 50% → swarm 100%）。

## 3) 驗證 join 咗
```bash
curl -s -H "x-swarm-token: <token>" "https://swarmai.club/swarm/nodes"            # 有冇註冊
curl -s -H "x-swarm-token: <token>" "https://swarmai.club/swarm/credits/<client-xxx>"  # SWAI 餘額
```

## FAQ
- Token 點攞？ Portal signup 即派；登入可攞返。
- 冇 GPU 得唔得？ 可以 `--pull` 都要 llama 嘅；純 client 用 portal 就得。
