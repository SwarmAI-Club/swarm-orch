# SwarmAI — swarm-orch

去中心化 AI 算力網絡嘅 orchestration layer。**Node router + Python worker** 混合架構，借 Symphony (GradientHQ, arXiv:2508.20019) 嘅 beacon routing + capability matching + weighted CoT voting 概念，自家實作。

## 協議（5 種 JSON messages）

`protocol/messages.json` — `node_register` / `beacon` / `beacon_response` / `task_assign` / `task_result`

Transport Phase 1 = HTTP over Tailscale mesh（100.x），協議層已抽象可換 libp2p/MQ。

## 架構

```
Worker (Python, llama-server /completion)
   │ node_register
   ▼
Router (Node) ── beacon ──► multiple workers
   ◄──────────────────────── beacon_response (confidence)
   ▼
   task_assign ──► worker(s) ──► task_result (votes[])
   ▼
   weighted majority voting → final answer
```

## 快速開始

```bash
# router (main node)
npm install
npm run router            # :4900

# worker (each GPU node)
python3 worker-node/worker.py \
  --router http://100.70.76.100:4900 \
  --node-id rtx2080ti \
  --completion http://100.106.211.51:8085/completion \
  --capabilities reasoning math analysis code
```

## Benchmark（Phase 1 PoC）

對比直解 vs Swarm voting：
- **BBH** (Big-Bench Hard) — Symphony paper: Qwen2.5-7B direct 73.19% → Symphony 86.23%
- **AMC** — direct 16.87% → 25.30%

```bash
python3 benchmarks/fetch_bbh.py        # fetch + cache subset
python3 benchmarks/fetch_amc.py
```

## Design notes
- **Capability matching**: Jaccard (∩/∪) 第一階段；Phase 2 上 LinUCB bandit routing
- **Voting**: weighted majority `Σ(confidence_i × I(a_i=a))`
- **唔改動現有 agent-core**（production trading），獨立包

MIT License · 詳情：swarmai.club