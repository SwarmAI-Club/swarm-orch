# 🐝 How To（用戶開戶 · 安裝 · 使用）

> 快速起步 3 步；詳細圖文/API：docs/USER_AND_API_GUIDE.html、CLIENT_SETUP.md。

## ① 開戶（攞 API token）
- 開 **https://swarmai.club/portal/** → Sign up（email+password）→ 即派 `X-Swarm-Token` + `node_id`（`client-xxx`）。
- Portal dashboard 同時睇你嘅 SWAI 點數。

## ② 安裝（GPU 機做 Worker，NAT 後都用到）
```bash
# 起你部機 model
./llama-server -m /path/to/Qwythos-9B-....gguf --host 127.0.0.1 --port 8080 -ngl 99

git clone https://github.com/SwarmAI-Club/swarm-orch.git && cd swarm-orch
docker build -f sandbox/Dockerfile -t swarm-worker .

docker run -d --name swarm-worker \
  -e SWARM_ROUTER="https://swarmai.club/swarm" \
  -e SWARM_API_TOKEN="<token>" \
  -e SWARM_COMPLETION="http://host.docker.internal:8080/completion" \
  swarm-worker python worker.py \
    --router "https://swarmai.club/swarm" --token "$SWARM_API_TOKEN" \
    --completion "$SWARM_COMPLETION" --node-id "<client-xxx>" \
    --capabilities reasoning math code --pull --heartbeat 30
```

## ③ 使用
```bash
# 驗證
curl -s -H "x-swarm-token: <token>" "https://swarmai.club/swarm/nodes"
# 落單
curl -s -H "x-swarm-token: <token>" -X POST "https://swarmai.club/swarm/task" \
  -d '{"prompt":"7*6-4? (A)38 (B)42 (C)40 (D)44","required_capabilities":["reasoning"],"n_votes":3}'
# 收答案（攞到 task_id 後）
curl -s -H "x-swarm-token: <token>" -X POST "https://swarmai.club/swarm/vote" \
  -d '{"task_id":"<task_id>","beacon_id":"<beacon_id>"}'
# 睇額
curl -s -H "x-swarm-token: <token>" "https://swarmai.club/swarm/credits/<client-xxx>"
```
