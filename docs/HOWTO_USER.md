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

## 用 OpenAI-compatible API（SwarmAI Gateway）

SwarmAI 提供 OpenAI 兼容端點 — 直接 replace 任何 OpenAI client 嘅 base_url + api_key 就用得。

### 基本資料
- **Base URL**: `https://swarmai.club/swarm/v1`
- **API key**: `sk-swai-<你條 X-Swarm-Token>`（portal 攞）
- **Models**:
  - `swarmai-fast` — 派去 S/A tier 勁機（5090/4090/2080Ti），收費貴（×1.8/×1.3）
  - `swarmai-normal` — 派去 B/C tier 平機，收費平（×1.0/×0.6）
  - `swarmai-image` — 圖像生成（SD-WebUI/ComfyUI adaptive worker），每張 ~20 SWAI
  - `swarmai-video` — 視訊生成（Wan adapter），每條 ~80 SWAI
  - vision 自動分流：messages 含 base64 `image_url` → 自動用 qwen2.5-vl
- **收費**: 按 tokens（in 5000t/SWAI、out 1000t/SWAI × tier 倍率）；balance 唔夠 → 自動 fallback 自己機+free machine（Profile 有派工狀態）；連 fallback 都冇先 402

### curl 例子
```bash
curl https://swarmai.club/swarm/v1/chat/completions \
  -H "Authorization: Bearer sk-swai-<token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"swarmai-fast","messages":[{"role":"user","content":"Hello"}],"max_tokens":200}'
```

### Python（openai SDK）
```python
from openai import OpenAI
client = OpenAI(base_url="https://swarmai.club/swarm/v1",
                api_key="sk-swai-<token>")
r = client.chat.completions.create(
    model="swarmai-fast",
    messages=[{"role":"user","content":"Hello"}])
print(r.choices[0].message.content)
```

### Node.js（openai 套件）
```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://swarmai.club/swarm/v1", apiKey: "sk-swai-" + TOKEN });
const r = await client.chat.completions.create({ model: "swarmai-normal", messages: [{role:"user",content:"Hi"}] });
console.log(r.choices[0].message.content);
```

### Vision（自動分流）
```python
b64 = open("img.png","rb").read()  # 或任何 base64
r = client.chat.completions.create(
    model="swarmai-normal",   # 唔需要特別揀 vision model
    messages=[{"role":"user","content":[
        {"type":"text","text":"點樣形容呢張圖？"},
        {"type":"image_url","image_url":{"url":f"data:image/png;base64,{b64_base64}"}}
    ]}])
```
> SwarmAI 偵測到 `image_url`/`data:image/` 自動 route 去 vision LLM（qwen2.5-vl），純按 tokens 收費。

### 回覆格式
```json
{"choices":[{"message":{"role":"assistant","content":"..."}}],
 "usage":{"prompt_tokens":..,"completion_tokens":..},
 "swarmai":{"nodes":[...],"votes":[...],"confidence":..,"est_fee":..,
            "mode":"self|paid|fallback|free",        // 派工模式（自己機免費/出面付費/降級自己機/free node）
            "notice":"SWAI 唔夠 → 已自動落返自己機 + free machine（免費）"}}
```
> `swarmai.mode=fallback` 代表 token 唔夠自動用緊自己機（唔扣）；想用出面機就登入 portal 充值（USDC，1:100）。

## 自己 node 點玩法（2026-09-19）

- **自己機優先**：`users.dispatch_pref`（portal Profile 可改）＝`self`（預設：自己機 available 就派自己、唔扣 token）`fastest`（唔理自己優先）`free-first`（自己＋free 一併優先）。
- **main 私有**：mainpc 唔 share（`main`/`qwen-vision` 已 SUSPEND）—— 你 main 只係 Router + 私人可用（直接 call `127.0.0.1:8087/8090` 或經 portal 派返自己 free node）。
- **Vision 免費**：vision 任務只派免費 node（`rtx2080ti-vl` Qwen-VL 高質 primary + `rtx2060a/b` backup）—— 任何人用 vision 都唔扣 token。
- **文字 sharing**：2060a/b free（唔扣）；rtx3060/rtx2080ti 非 free（作 paid 選項）。

## 自學（Learn-Agent）玩（進階）

- `learn-agent`（rtx2080ti Docker）每 ~30min 自學一題（`/kb` note + spaced-repetition）。
- 難題想提升準確率：**self-consistency**（同一題抖 temperature 3 次攞多數）最經濟 —— 實測 12 題 BBH+AMC 由 10/12 升到 11/12（`docs/QUANTITY_LEARN_STUDY.md`）。
- Learn 出嘅 notes 可分享返社群（互相施予）。
