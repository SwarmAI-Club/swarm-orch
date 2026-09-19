#!/usr/bin/env python3
"""SwarmAI Quantity Learn-Study — 驗證「數量取勝」策略 (BBH + AMC 標準題, 5 strategies)

Run:  python3 benchmarks/run_quantity.py --token <tok> --router http://127.0.0.1:4900
Output: benchmarks/report_quantity.html (Chart.js, 中英雙語) + result JSON
"""
import argparse, json, os, sys, time, urllib.request, urllib.error

ROUTER = os.environ.get("SWARM_ROUTER", "")
ROUTER = "http://127.0.0.1:4900"
TOKEN = ""
N_SAMPLES = 3            # 每策略每題 sample 數
MODEL = os.environ.get("QMODEL", "swarmai-free")  # 單 node 穩定（freeOnly），避多機 contamination

# 標準題庫（BBH 多選 + AMC 風格數學，全部有 ground truth）
QUESTIONS = [
    # BBH 風格推理多選
    {"q": "A broker charges 0.1% commission on a $10000 order. How much is the fee?",
     "options": "(A) $1 (B) $10 (C) $100 (D) $0.1", "answer": "B"},
    {"q": "Ann is younger than Bob but older than Cam. Who is the youngest?",
     "options": "(A) Ann (B) Bob (C) Cam (D) Cannot determine", "answer": "C"},
    {"q": "What is log base 10 of 1000?", "options": "(A) 10 (B) 3 (C) 100 (D) 1000", "answer": "B"},
    {"q": "A 0.1 mm sheet is folded in half 10 times. Approx total thickness?",
     "options": "(A) about 10 cm (B) about 102 mm (C) about 1 mm (D) about 20 mm", "answer": "B"},
    {"q": "Which statement about the number 17 is true?",
     "options": "(A) It is even (B) It is prime (C) It is a perfect square (D) It is divisible by 3", "answer": "B"},
    {"q": "What is 7 times 6 minus 4?", "options": "(A) 38 (B) 42 (C) 40 (D) 44", "answer": "A"},
    # AMC 風格數學
    {"q": "If x + (1/x) = 3, compute x^2 + (1/x^2).",
     "options": "(A) 5 (B) 7 (C) 9 (D) 11", "answer": "B"},
    {"q": "How many positive integers less than 100 are divisible by both 3 and 4?",
     "options": "(A) 8 (B) 12 (C) 16 (D) 6", "answer": "A"},
    {"q": "The sum of two consecutive integers is 27. What is the larger?",
     "options": "(A) 13 (B) 14 (C) 15 (D) 16", "answer": "B"},
    {"q": "A triangle has angles in ratio 1:2:3. What is the largest angle?",
     "options": "(A) 60° (B) 90° (C) 120° (D) 30°", "answer": "B"},
    {"q": "What is the 5th term of the sequence 2, 6, 12, 20, ...?",
     "options": "(A) 28 (B) 30 (C) 32 (D) 36", "answer": "B"},
    {"q": "If 3^x = 81, what is x?",
     "options": "(A) 3 (B) 4 (C) 5 (D) 9", "answer": "B"},
]

def hdrs():
    return {"content-type": "application/json", "x-swarm-token": TOKEN}

def http_json(url, data=None, timeout=60):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=hdrs())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def make_prompt(q, direction=None):
    # 明確要求「淨係一個字母」，避免 model 答數字/長文
    head = ("Answer ONLY the correct option letter (A, B, C, or D). "
            "Do not explain. Do not answer with words or numbers. "
            "Your entire reply must be exactly one character.")
    p = f"{head}\n\nQ: {q['q']}\nOptions: {q['options']}"
    if direction:
        p = f"{head}\n\nSolve using this approach: '{direction}'.\n\nQ: {q['q']}\nOptions: {q['options']}"
    return p

def letter(ans):
    # extract A/B/C/D — 優先結尾括號/字母（Qwythos 輸出去到 "(B)" 或 "Answer: C"）
    a = str(ans or "").strip()
    import re
    for pat in (r"\(([ABCD])\)", r"Answer[:\s]*([ABCD])$", r"([ABCD])\s*$", r"\b([ABCD])\b"):
        m = re.search(pat, a, re.I | re.M)
        if m:
            return m.group(1).upper()
    return None

def v1chat(prompt, temperature=0.6, model=MODEL, max_tokens=96, _retry=3):
    import time as _t
    for i in range(_retry):
        try:
            d = http_json(f"{ROUTER}/v1/chat/completions",
                          {"model": model, "messages": [{"role": "user", "content": prompt}],
                           "temperature": temperature, "max_tokens": max_tokens, "stop": ["\n\nUSER:", "\n\nQ:", "Q: If"]},
                          timeout=90)
            return str(d.get("choices", [{}])[0].get("message", {}).get("content", ""))
        except Exception as e:
            if i == _retry - 1:
                raise
            _t.sleep(1.5)
    raise RuntimeError("v1chat exhausted")

# ---- 5 strategies ----
def strat_A_direct(q):
    """單 node 単答（baseline）"""
    raw = v1chat(make_prompt(q))
    a = letter(raw)
    print(f"[A dbg] raw={raw[:60]!r} -> letter={a}", file=sys.stderr)
    return {"answers": [a], "result": a}

def strat_B_majority(q):
    """多機多 model 各答一次 → majority（router 派唔同 node）"""
    from collections import Counter
    answers = []
    for m in ["swarmai-free", "swarmai-normal", "swarmai-free"]:  # free=2060b, normal=2060, free=2060a
        answers.append(letter(v1chat(make_prompt(q), temperature=0.6, model=m)))
    c = Counter(a for a in answers if a)
    return {"answers": answers, "result": c.most_common(1)[0][0] if c else None}

def strat_C_self_consistency(q):
    """同題 3 次抖 temp → mode"""
    temps = [0.2, 0.6, 0.9]
    from collections import Counter
    answers = []
    for t in temps[:N_SAMPLES]:
        answers.append(letter(v1chat(make_prompt(q), temperature=t)))
    c = Counter(a for a in answers if a)
    return {"answers": answers, "result": c.most_common(1)[0][0] if c else None}

def strat_D_divergent(q):
    """3 種解法方向 → majority"""
    dirs = ["brute force check all options", "algebraic derivation", "construct a counterexample"]
    from collections import Counter
    answers = []
    for dr in dirs[:N_SAMPLES]:
        answers.append(letter(v1chat(make_prompt(q, direction=dr), temperature=0.6)))
    c = Counter(a for a in answers if a)
    return {"answers": answers, "result": c.most_common(1)[0][0] if c else None}

def strat_E_verifier(q):
    """産出答案群 → 同一 node 獨立 session 揀 best（verifier=Qwythos）"""
    # 生成多個 answers
    from collections import Counter
    cand = []
    for t in [0.3, 0.7]:
        cand.append((letter(v1chat(make_prompt(q), temperature=t)), t))
    # 指定 verifier 揀
    items = "\n".join(f"- Candidate {i+1}: {a}" for i, (a, _) in enumerate([c for c in cand if c[0]]))
    v_txt = f"Multiple candidates answered this MCQ. Which ONE option letter is correct? Verify carefully.\n\nQ: {q['q']}\nOptions: {q['options']}\n{items}\n\nAnswer with ONLY the correct option letter:"
    v_ans = letter(v1chat(v_txt, temperature=0.1))
    answers = [a for a, _ in cand]
    return {"answers": answers, "result": v_ans}

STRATEGIES = {"A_direct": strat_A_direct, "B_majority": strat_B_majority,
              "C_selfconsistency": strat_C_self_consistency, "D_divergent": strat_D_divergent,
              "E_verifier": strat_E_verifier}

def main():
    global TOKEN, N_SAMPLES, ROUTER
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--router", default=ROUTER)
    ap.add_argument("--samples", type=int, default=N_SAMPLES)
    args = ap.parse_args()
    TOKEN = args.token
    ROUTER = args.router
    N_SAMPLES = args.samples

    results = {"ts": int(time.time()), "samples": N_SAMPLES, "strategies": {}, "questions": len(QUESTIONS)}
    for sid, fn in STRATEGIES.items():
        results["strategies"][sid] = {"correct": 0, "answers": []}
        for qi, q in enumerate(QUESTIONS):
            try:
                if qi == 0 and sid == "A_direct":
                    print(f"[dbg] fn={fn.__name__} ROUTER={ROUTER} MODEL={MODEL} N_SAMPLES={N_SAMPLES}", file=sys.stderr)
                r = fn(q)
            except Exception as e:
                r = {"answers": [], "result": None, "error": str(e)}
            if r.get("result") is None and r.get("error"):
                print(f"  → {sid} Q{qi} EXC: {r['error']}", file=sys.stderr)
            ok = r.get("result") == q["answer"]
            if ok:
                results["strategies"][sid]["correct"] += 1
            results["strategies"][sid]["answers"].append({"q": qi, "result": r.get("result"),
                                                          "correct": q["answer"], "ok": ok,
                                                          "raw": r.get("answers")})
            print(f"[{sid}] Q{qi}: result={r.get('result')} correct={q['answer']} -> {'✓' if ok else '✗'}")
        print(f"[{sid}] 準確率: {results['strategies'][sid]['correct']}/{len(QUESTIONS)}")

    # Save JSON
    os.makedirs(os.path.dirname(os.path.abspath(__file__)), exist_ok=True)
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
    os.makedirs(base, exist_ok=True)
    jp = os.path.join(base, f"quantity_{results['ts']}.json")
    with open(jp, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("JSON saved:", jp)
    build_html(results)
    print("HTML saved: benchmarks/report_quantity.html")

def build_html(results):
    labels = ["Q%d" % i for i in range(results["questions"])]
    data = {}
    for sid in STRATEGIES:
        data[sid] = [1 if a["ok"] else 0 for a in results["strategies"][sid]["answers"]]
    acc = {sid: results["strategies"][sid]["correct"] / results["questions"] * 100
           for sid in STRATEGIES}
    perq_rows = ""
    for sid in STRATEGIES:
        cells = ""
        for i in range(results["questions"]):
            cls = "ok" if data[sid][i] else "no"
            mark = "✓" if data[sid][i] else "✗"
            cells += f"<td class='{cls}'>{mark}</td>"
        perq_rows += f"<tr><td><b>{sid}</b></td>{cells}<td>{acc[sid]}%</td></tr>"
    qheads = "".join(f"<th>Q{i}</th>" for i in range(results["questions"]))
    js = (
        "const acc = " + json.dumps({k: round(v, 1) for k, v in acc.items()}) + ";\n"
        "new Chart(document.getElementById('acc'), {type:'bar', data:{labels:Object.keys(acc), "
        "datasets:[{data:Object.values(acc), backgroundColor:['#64748b','#22d3ee','#a855f7','#f59e0b','#4ade80']}]}, "
        "options:{plugins:{legend:{display:false}, title:{display:true,text:'Accuracy % (準確率)'}}, scales:{y:{max:100}}}});\n"
        "const perq = " + json.dumps(data, ensure_ascii=False) + ";\n"
        "new Chart(document.getElementById('perq'), {type:'bar', data:{labels:" + json.dumps(labels) + ", "
        "datasets:Object.keys(perq).map(k=>({label:k,data:perq[k],stack:'s',backgroundColor:'#334155'}))}, "
        "options:{plugins:{legend:{labels:{color:'#cbd5e1'}}}, scales:{x:{stacked:true},y:{stacked:true,max:1}}}});\n"
    )
    acc_rows = "".join(
        f"<tr><td>{k}</td><td class=\"{'ok' if v>=50 else 'no'}\">{v}%</td></tr>" for k, v in acc.items()
    )
    template = """<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>SwarmAI Quantity Learn-Study Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>body{{font-family:-apple-system,sans-serif;background:#0b1220;color:#cbd5e1;padding:24px}}
h1{{font-size:1.4rem}} h2{{font-size:1.1rem;color:#22d3ee}} table{{border-collapse:collapse;font-size:.85rem}}
td,th{{border:1px solid #1f2937;padding:6px 10px}} .ok{{color:#4ade80}} .no{{color:#f87171}}
.chartbox{{max-width:900px;margin:20px 0}}</style></head><body>
<h1>&#x1F41D; SwarmAI Quantity Learn-Study &#8212; &#x300C;&#x6578;&#x91CF;&#x53D6;&#x52DD;&#x300D;&#x7B56;&#x7565;&#x5C0D;&#x6BD4;</h1>
<p>{samples} samples per strategy &#183; {ts}</p>
<div class="chartbox"><canvas id="acc"></canvas></div>
<h2>Accuracy (&#x6E96;&#x78BA;&#x7387; %)</h2>
<table><tr><th>Strategy</th><th>Accuracy</th></tr>{acc_rows}</table>
<div class="chartbox"><canvas id="perq"></canvas></div>
<h2>Per-question correct</h2>
<table><tr><th>Q</th>{qheads}<th>Acc</th></tr>{perq_rows}</table>
<script>{js}</script></body></html>"""
    html = template.format(samples=results["samples"], ts=time.strftime('%Y-%m-%d %H:%M'), qheads=qheads,
                           perq_rows=perq_rows, acc_rows=acc_rows, js=js)
    hp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "report_quantity.html")
    with open(hp, "w", encoding="utf-8") as f:
        f.write(html)
    print("--- summary ---")
    for sid in STRATEGIES:
        print(f"  {sid}: {acc[sid]:.1f}%")

if __name__ == "__main__":
    main()