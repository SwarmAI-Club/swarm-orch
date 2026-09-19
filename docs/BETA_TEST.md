# 🧪 SwarmAI 外部實測指南（US / UK / AU 朋友用）

> 目的：驗證「新人加入 SwarmAI」喺世界各地（唔同時區/網絡/NAT）都 Work。
> 你只需要做到 **Level 1**；有 GPU/有空機先做 **Level 2**；想做進階先做 Level 3。
> 回報方式：做完喺 TG 群講一聲（你部機 node_id / email），馬可喺後台驗證。

---

## Level 1 — 開戶 + 用 AI（5 分鐘，人人都做）

**目的**：證明「新人可以靠 email 開戶、攞 token、即刻用 AI（唔使安裝任何嘢、唔使 GPU）」。

### 步驟
```bash
# 1) 開戶（會有 email）
curl -s -X POST "https://swarmai.club/portal/signup" \
  -H 'content-type: application/json' \
  -d '{"email":"<你嘅email>","password":"<強密碼 13位以上含大小寫數字符號>"}'
# → 會回 api_token 同 node_id（記低）

# 2) 用 AI 問嘢（用上面條 token）
curl -s -X POST "https://swarmai.club/swarm/v1/chat/completions" \
  -H "x-swarm-token: <api_token>" -H 'content-type: application/json' \
  -d '{"model":"swarmai-free","messages":[{"role":"user","content":"如果 x+1/x=3，計算 x^2+1/x^2"}],"max_tokens":100}'
# → 應該見到 "content": "..." 有 AI 答

# 3) 睇自己 balance
curl -s -H "x-swarm-token: <api_token>" "https://swarmai.club/swarm/portal/me"
# → 應該見到 balance: 50
```

### 點知成功
- step 2 有 `"content":` 作答，step 3 `balance: 50`
- 將呢兩個輸出貼上群（email 同 token 尾段），等後台對數

---

## Level 2 — 出一部機做 worker（有 GPU / 有空機先做）

**目的**：證明「外面一部家用機可以加入做 node、收到任務、出真算力」（重點：NAT 後 `--pull` 模式唔使人哋開 port）。

### 步驟（Linux 為例）
```bash
# 0) 起 model（有 llama-server 就用；冇就 skip Level 2）
./llama-server -m <你部機的Qwythos/Qwen gguf> --host 127.0.0.1 --port 8080 -ngl 99

git clone https://github.com/SwarmAI-Club/swarm-orch.git && cd swarm-orch
pip install requests

# 1) 起 worker（--pull：只出 outward，NAT/router 後都得）
python3 worker-node/worker.py \
  --router "https://swarmai.club/swarm" --token "<api_token>" \
  --completion "http://127.0.0.1:8080/completion" \
  --node-id "<你signup攞到嘅 client-xxx>" \
  --capabilities reasoning math code --pull --heartbeat 30
```

### 點知成功
- 有啟動 log：`registered ... -> ... (N nodes)`
- 等 1 分鐘 → router 會開始派簡單任務俾你（睇 `[worker] pull processed`）
- 喺群度話聲「我部機 <node_id> 上咗線」
- 後台驗證：你部機 node 出現喺網絡 nodes 列表，有 task 派過嚟

---

## Level 3 — 進階（可選）：Vision 免費測試

**目的**：證明「新人用 vision（睇圖）都係免費、自動分流」。

```bash
# 用任何相（base64）問圖
curl -s -X POST "https://swarmai.club/swarm/v1/chat/completions" \
  -H "x-swarm-token: <api_token>" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":[
        {"type":"text","text":"描述呢張圖"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,<圖片base64>"}}]}],
        "max_tokens":100}'
# → 應該有 AI 描述到張圖，response 有 "mode":"free"（唔扣 token）
```

---

## 後台點驗證（馬可你唔使做）

- **Level 1**：router log 出現新 user signup；`/portal/me` balance=50 對得上
- **Level 2**：`/nodes` 新 node 上線（`client-xxx`）+ `[v1]`/task dispatch log 派過工
- **Level 3**：vision request 派去 `rtx2080ti-vl` / 2060a/b，`mode:free`
- 驗證工具（mainpc）：
  ```bash
  bash agent-core/install-smoke-daily.sh          # 全流程自測
  python3 benchmarks/install_test.py --router https://swarmai.club/swarm --worker 0 --email <test>
  # router log 收 node activity 已有
  ```

## 測試回報建議格式（貼群）
```
[測試] <城市> · Level 1 ✅ balance=50 · Level 2 ✅ node=<client-xxx> · Level 3 ✅ vision free
```