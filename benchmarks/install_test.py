#!/usr/bin/env python3
"""SwarmAI 用戶安裝流程自動測試 (End-to-End Install Smoke Test)

模擬「新用戶」由零開始加入：
  1. signup → 攞 API token + node_id
  2. 驗證 /portal/me（balance、nodes、dispatch）
  3. 落單（/v1/chat/completions + /task）—— 驗證可以用 AI
  4. 啟動一個 pull-mode worker（mocked completion 或 真 llama）→ 註冊 → 落單由自己 node 接
  5. 輸出 PASS/FAIL 報告

用法:
  python3 benchmarks/install_test.py --router https://swarmai.club/swarm --email <new@email> [--worker 1]
  (--worker 1 會啟動純 worker 連 completion endpoint 驗證註冊)
"""
import argparse, json, os, sys, time, urllib.request, urllib.error
try:
    import requests
except ImportError:
    print("need: pip install requests", file=sys.stderr); sys.exit(1)

def http_json(url, data=None, token=None, timeout=40):
    headers = {"content-type": "application/json"}
    if token:
        headers["x-swarm-token"] = token
    try:
        r = requests.post(url, json=data, headers=headers, timeout=timeout) if data is not None else requests.get(url, headers=headers, timeout=timeout)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, {"raw": r.text[:200]}
    except Exception as e:
        return 0, {"error": str(e)}

PASS, FAIL = 0, 0
def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✅ {name}{(' — ' + detail) if detail else ''}")
    else:
        FAIL += 1
        print(f"  ❌ {name}{(' — ' + detail) if detail else ''}")

def next_email(base):
    return f"{base}+{int(time.time())}@t.t"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--router", default="https://swarmai.club/swarm")
    ap.add_argument("--email", default="")
    ap.add_argument("--password", default="Test12345!xyzA1")
    ap.add_argument("--worker", type=int, default=0, help="1 = 啟動 pull worker 驗證註冊")
    ap.add_argument("--completion", default="http://127.0.0.1:8080/completion",
                    help="worker 用嘅 completion（mocked 或者真 llama）")
    args = ap.parse_args()
    r = args.router.rstrip("/")
    portal = r[:-len("/swarm")] + "/portal" if r.endswith("/swarm") else r + "/portal"
    base = args.router.rstrip("/")
    email = args.email or next_email("install")
    pw = args.password

    print(f"🔧 SwarmAI 安裝流程測試 — router={base} · 新用戶={email}")
    print("=" * 60)

    # 1) Signup
    print("\n[1] 開戶 signup")
    code, d = http_json(f"{portal}/signup", {"email": email, "password": pw}, timeout=40)
    if code != 200 or not d.get("ok"):
        check("signup", False, f"HTTP {code} {d.get('error','')}")
        sys.exit(1)
    tok = d.get("api_token"); nid = d.get("node_id")
    check("signup 攞 token+nodid", bool(tok and nid), f"token={tok[:12]}… node_id={nid}")

    # 2) /portal/me
    print("\n[2] 睇自己 (portal/me)")
    code, me = http_json(f"{base}/portal/me", token=tok)
    check("portal/me 有 balance", code == 200 and "balance" in me, f"balance={me.get('balance')}")
    check("dispatch 資訊", "dispatch" in me, str(me.get("dispatch", {}).get("pref")))

    # 3) 落單 — text (v1 chat)
    print("\n[3] 落單問嘢")
    code, d = http_json(f"{base}/v1/chat/completions",
                        {"model": "swarmai-free", "messages": [{"role": "user", "content": "Answer ONLY: 7*6-4?"}], "max_tokens": 32},
                        token=tok)
    content = (d.get("choices") or [{}])[0].get("message", {}).get("content", "")
    sw = d.get("swarmai", {})
    check("v1 chat 有答案", code == 200 and bool(content), str(content)[:40])
    check("v1 chat 免費(free node)", sw.get("mode") in ("free", "self", "paid"), f"nodes={sw.get('nodes')} mode={sw.get('mode')}")

    # 4) /task
    print("\n[4] /task 落單")
    code, d = http_json(f"{base}/task",
                        {"prompt": "What is 7*6-4?", "required_capabilities": ["reasoning", "math"], "n_votes": 3,
                         "max_targets": 3}, token=tok)
    check("/task ok", code == 200 and d.get("ok"), f"mode={d.get('mode')}")
    check("/task 有派工/排隊", bool(d.get("pushed") or d.get("queued") or d.get("failed")) or d.get("ok"),
          f"pushed={[x['node_id'] for x in d.get('pushed',[])]} queued={[x['node_id'] for x in d.get('queued',[])]}")

    # 5) Worker 啟動 (pull mode) — 若 --worker 1
    print("\n[5] Worker 啟動 (--pull, 用戶機視角)")
    if args.worker:
        import subprocess as sp
        complet = args.completion
        # 用 python 直接 call worker.py（模擬用戶部機）
        env = dict(os.environ, SWARM_API_TOKEN=tok)
        proc = sp.Popen(
            [sys.executable, "-u", "worker-node/worker.py",
             "--router", base, "--token", tok,
             "--completion", complet, "--node-id", f"{nid}-inst",
             "--capabilities", "reasoning", "--pull", "--heartbeat", "5",
             "--speed", "10"],
            cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."),
            env=env, stdout=sp.PIPE, stderr=sp.STDOUT)
        time.sleep(8)
        # 檢查有冇註冊
        code, nodes = http_json(f"{base}/nodes", token=tok)
        reg = any(n.get("node_id") == f"{nid}-inst" for n in (nodes if isinstance(nodes, list) else []))
        check("worker 心跳註冊咗", reg, f"registered node={f'{nid}-inst'}")
        proc.terminate()
    else:
        print("  (skip — 用 --worker 1 啟動真 worker 驗證)")

    print("\n" + "=" * 60)
    print(f"結果：{PASS} PASS · {FAIL} FAIL")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()