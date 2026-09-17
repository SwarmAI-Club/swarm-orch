#! /usr/bin/env python3
"""SwarmAI swarm-reasoning demo — 3×Qwythos 對比：direct vs weighted voting.

流程每題:
  direct   = 單 node（main）直接答
  swarm    = router beacon → 3 個 worker 各生成 1 vote → weighted majority (router /vote)
輸出 benchmarks/results/swarm_demo_<ts>.json + 準確率對比表
"""
import json, os, re, sys, time, uuid

import requests

ROUTER = os.environ.get("SWARM_ROUTER", "http://100.70.76.100:4900")
MAIN_COMPLETION = os.environ.get("SWARM_MAIN_COMPLETION", "http://100.70.76.100:8087/completion")

QUESTIONS = [
    {"q": "What is 7 times 6 minus 4?", "options": "(A) 38 (B) 42 (C) 40 (D) 44", "answer": "A"},
    {"q": "A broker charges 0.1% commission on a 10000 order. How much is the fee?", "options": "(A) 1 (B) 10 (C) 100 (D) 0.1", "answer": "B"},
    {"q": "Which statement about the number 17 is true?", "options": "(A) It is even (B) It is prime (C) It is a perfect square (D) It is divisible by 3", "answer": "B"},
    {"q": "What is log base 10 of 1000?", "options": "(A) 10 (B) 3 (C) 100 (D) 1000", "answer": "B"},
    {"q": "Ann is younger than Bob but older than Cam. Who is the youngest?", "options": "(A) Ann (B) Bob (C) Cam (D) Cannot determine", "answer": "C"},
    {"q": "A 0.1 mm sheet is folded in half 10 times. Approximate total thickness?", "options": "(A) about 10 cm (B) about 102 mm (C) about 1 mm (D) about 20 mm", "answer": "B"},
]

N_VOTES = 1


def make_prompt(q):
    return (f"Solve the following multiple-choice question. Reason briefly, then answer with "
            f"only the option letter in the format (A).\n\nQuestion: {q['q']}\n{q['options']}")


def letter(ans):
    m = re.search(r"\(([A-D])\)", ans or "")
    if m:
        return m.group(1)
    m = re.search(r"\b([A-D])\b", ans or "")
    return m.group(1) if m else "X"


def direct_answer(completion_url, prompt):
    r = requests.post(completion_url, json={
        "prompt": f"{prompt}\n\nASSISTANT:", "n_predict": 48, "temperature": 0.2,
        "stop": ["<|im_end|>"],
    }, timeout=300)
    r.raise_for_status()
    return letter(r.json().get("content", ""))


def swarm_answer(q):
    task_id = uuid.uuid4().hex[:12]
    prompt = make_prompt(q)
    beacon = requests.post(f"{ROUTER}/beacon", json={
        "task": q["q"], "required_capabilities": ["reasoning", "math"],
        "priority": 1,
    }, timeout=15).json()
    accepted = [r for r in beacon.get("responses", []) if r.get("accepted")]
    nodes = {n["node_id"]: n["url"] for n in requests.get(f"{ROUTER}/nodes", timeout=10).json()}
    votes_done = 0
    for r in accepted:
        url = nodes.get(r["node_id"])
        if not url:
            continue
        assign = requests.post(f"{url}/assign", json={
            "task_id": task_id, "beacon_id": beacon["beacon_id"], "prompt": prompt,
            "n_votes": N_VOTES, "temperature": 0.6,
        }, timeout=320)
        if assign.status_code == 200:
            votes_done += 1
    time.sleep(2)
    vote = requests.post(f"{ROUTER}/vote", json={"task_id": task_id, "beacon_id": beacon["beacon_id"]}, timeout=15).json()
    return vote.get("winner") and letter(vote.get("winner")), vote


def main():
    out = {"ts": int(time.time()), "router": ROUTER, "questions": []}
    direct_c = swarm_c = total = 0
    for q in QUESTIONS:
        prompt = make_prompt(q)
        d = direct_answer(MAIN_COMPLETION, prompt)
        s, vote = swarm_answer(q)
        total += 1
        dc = d == q["answer"]
        sc = s == q["answer"]
        direct_c += dc
        swarm_c += sc
        out["questions"].append({
            "q": q["q"], "answer": q["answer"], "direct": d, "swarm": s,
            "direct_correct": dc, "swarm_correct": sc, "tally": vote.get("tally"),
        })
        print(f"[{total}/{len(QUESTIONS)}] {q['q'][:40]}...  direct={d}({'✓' if dc else '✗'})  swarm={s}({'✓' if sc else '✗'})")
    out["accuracy"] = {"direct": direct_c, "swarm": swarm_c, "total": total,
                       "direct_pct": direct_c / total, "swarm_pct": swarm_c / total,
                       "lift": swarm_c - direct_c}
    res_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
    os.makedirs(res_dir, exist_ok=True)
    fp = os.path.join(res_dir, f"swarm_demo_{out['ts']}.json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("=== SUMMARY ===")
    print(f"direct accuracy : {out['accuracy']['direct_pct']:.0%} ({direct_c}/{total})")
    print(f"swarm accuracy  : {out['accuracy']['swarm_pct']:.0%} ({swarm_c}/{total})  (lift {out['accuracy']['lift']:+d})")
    print(f"saved -> {fp}")


if __name__ == "__main__":
    main()