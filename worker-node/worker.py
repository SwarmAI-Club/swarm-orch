#! /usr/bin/env python3
"""SwarmAI worker node — Python. 對接 llama-server /completion endpoint.

功能:
  - 上線註冊 (node_register)
  - HTTP server: GET /health, POST /beacon (accept + confidence), POST /assign (跑 CoT votes → task_result)
  - 可選 heartbeat loop (node_status)

用法:
  python3 worker-node/worker.py --router http://100.70.76.100:4900 \
    --node-id rtx2080ti --completion http://100.106.211.51:8087/completion \
    --capabilities reasoning math code --model qwythos-1m --gpu "2080Ti 22GB"
"""
import argparse, json, os, socket, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import requests
except ImportError:
    print("need: pip install requests", file=sys.stderr)
    sys.exit(1)


def jaccard(a, b):
    A, B = set(a), set(b)
    if not A or not B:
        return 0
    inter = len(A & B)
    return inter / len(A | B)


def llm_complete(completion_url, prompt, n_predict=512, temperature=0.6, image_data=None):
    body = {
        "prompt": f"{prompt}\n\nASSISTANT:",
        "n_predict": n_predict,
        "temperature": temperature,
        "stop": ["<|im_end|>"],
    }
    if image_data:
        body["image_data"] = image_data if isinstance(image_data, list) else [{"data": image_data}]
    r = requests.post(completion_url, json=body, timeout=300)
    r.raise_for_status()
    j = r.json()
    content = str(j.get("content", "")).strip()
    # llama-server /completion 回報 token 用量（用於按 tokens 計費）
    return {
        "content": content,
        "tokens_in": int(j.get("tokens_evaluated", 0) or 0),
        "tokens_out": int(j.get("tokens_predicted", 0) or 0),
    }


def _auto_bench(args):
    """自動測一次 tok/s（idle 產能計用）。若已有 --speed 則唔測。"""
    sp = args.speed
    try:
        spf = float(sp)
        return sp
    except (TypeError, ValueError):
        pass
    try:
        t0 = time.time()
        r = requests.post(args.completion, json={
            "prompt": "USER: 1+1=?\n\nASSISTANT:",
            "n_predict": 8, "temperature": 0.1,
            "stop": ["<|im_end|>"],
        }, timeout=60)
        j = r.json()
        n_out = int(j.get("tokens_predicted", 8) or 0)
        dt = time.time() - t0
        spd = n_out / dt if dt > 0 else 0
        print(f"[worker] auto-bench: ~{spd:.1f} tok/s", file=sys.stderr)
        return f"{spd:.1f}"
    except Exception as e:
        print(f"[worker] bench FAIL: {e}", file=sys.stderr)
        return sp


def _headers(args):
    h = {"content-type": "application/json"}
    if args.token:
        h["x-swarm-token"] = args.token
    return h

class Worker:
    def __init__(self, args):
        self.args = args
        self.info = {
            "type": "node_register",
            "node_id": args.node_id,
            "capabilities": args.capabilities,
            "model": args.model,
            "gpu": args.gpu,
            "max_context": args.max_context,
            "speed": args.speed,
            "share_ratio": args.share_ratio,
            "url": f"http://{args.listen}:{args.port}",
            "pull": args.pull,
        }

    def register(self, retries=3, delay=2):
        for i in range(retries):
            try:
                r = requests.post(self.args.router.rstrip("/") + "/register", json=self.info,
                                  headers=_headers(self.args), timeout=10)
                j = r.json()
                if not j.get("ok"):
                    print(f"[worker] register rejected: {j.get('error')}", file=sys.stderr)
                    return False
                print(f"[worker] registered {self.args.node_id} -> {self.args.router} ({j.get('nodes')} nodes)")
                return True
            except Exception as e:
                print(f"[worker] register attempt {i+1}/{retries} FAIL: {e}", file=sys.stderr)
                time.sleep(delay)
        return False

    def on_beacon(self, body):
        required = body.get("required_capabilities", [])
        score = jaccard(self.args.capabilities, required)
        accepted = score > 0
        return {"beacon_id": body.get("beacon_id"), "node_id": self.args.node_id,
                "accepted": accepted, "confidence": round(score, 3),
                "reason": "capability_match" if accepted else "no_capability"}

    def on_assign(self, body):
        prompt = body.get("prompt", "")
        n_votes = int(body.get("n_votes", 3))
        temperature = float(body.get("temperature", 0.6))
        images = body.get("image_data") or None
        votes = []
        tokens_in_total = 0
        tokens_out_total = 0
        t0 = time.time()
        for i in range(n_votes):
            res = llm_complete(self.args.completion, prompt, self.args.n_predict, temperature + (i * 0.05), images)
            votes.append({"content": res["content"], "confidence": round(0.9, 3), "reasoning": ""})
            tokens_in_total += res["tokens_in"]
            tokens_out_total += res["tokens_out"]
        payload = {
            "type": "task_result", "task_id": body.get("task_id"),
            "node_id": self.args.node_id, "votes": votes,
            "duration_ms": int((time.time() - t0) * 1000),
            "tokens_in": tokens_in_total, "tokens_out": tokens_out_total,
        }
        try:
            requests.post(self.args.router.rstrip("/") + "/result", json=payload, headers=_headers(self.args), timeout=20)
        except Exception as e:
            print(f"[worker] result post FAIL: {e}", file=sys.stderr)
        return {"ok": True, "votes": len(votes), "node_id": self.args.node_id}

    def heartbeat_once(self, sleeping=False):
        try:
            r = requests.post(self.args.router.rstrip("/") + "/status", json={
                "type": "node_status", "node_id": self.args.node_id,
                "status": "IDLE_SHARING" if sleeping else "USER_OCCUPIED",
                "vram_used_gb": self.args.vram, "model_loaded": self.args.model,
                "sleeping": sleeping, "ts": int(time.time()),
                "share_ratio": getattr(self.args, "share_ratio", 100),
                # 帶返完整資料，令 router 心跳 auto-register 唔會變冇 gpu/vram 嘅空 node
                "gpu": self.args.gpu, "vram": self.args.vram, "model": self.args.model,
                "speed": getattr(self.args, "speed", ""),
                "capabilities": self.args.capabilities,
                "url": self.info.get("url", ""),
                "pull": self.args.pull,
            }, headers=_headers(self.args), timeout=10)
            # router 重啟後（registry 空 / 未註冊）→ 自動補完整 /register
            if r.status_code in (401, 404) or r.json().get("ok") is False:
                print("[worker] 心跳未註冊 → re-register", file=sys.stderr)
                self.register(retries=2, delay=1)
        except Exception as e:
            print(f"[worker] heartbeat FAIL: {e}", file=sys.stderr)


def make_handler(worker):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _read(self):
            n = int(self.headers.get("content-length", 0))
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/health"):
                self._json({"ok": True, "node_id": worker.args.node_id})
            else:
                self._json({"ok": False}, 404)

        def do_POST(self):
            try:
                body = self._read()
                if self.path.startswith("/beacon"):
                    self._json(worker.on_beacon(body))
                elif self.path.startswith("/assign"):
                    self._json(worker.on_assign(body))
                else:
                    self._json({"ok": False}, 404)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 500)

    return H



def _poll_loop(worker):
    """Pull-mode worker: poll router inbox, run votes, post results. Only OUTBOUND needed."""
    while True:
        try:
            r = requests.get(worker.args.router.rstrip("/") + "/tasks/poll",
                             params={"node_id": worker.args.node_id}, headers=_headers(worker.args), timeout=20)
            r.raise_for_status()
            tasks = r.json().get("tasks") or []
            for t in tasks:
                worker.on_assign({"task_id": t["task_id"], "beacon_id": t.get("beacon_id"),
                                  "prompt": t.get("prompt", ""), "n_votes": t.get("n_votes", 3),
                                  "temperature": t.get("temperature", 0.6)})
            if tasks:
                print(f"[worker] pull processed {len(tasks)} task(s)", flush=True)
        except Exception as e:
            print(f"[worker] poll FAIL: {e}", file=sys.stderr, flush=True)
        time.sleep(3)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--router", default=os.environ.get("SWARM_ROUTER", "http://100.70.76.100:4900"))
    ap.add_argument("--token", default=os.environ.get("SWARM_API_TOKEN"), help="X-Swarm-Token（router 認證；必填）")
    ap.add_argument("--node-id", default=os.environ.get("HOSTNAME", "node-" + uuid.uuid4().hex[:6]))
    ap.add_argument("--completion", default=os.environ.get("SWARM_COMPLETION"), help="llama-server /completion URL")
    ap.add_argument("--capabilities", nargs="*", default=["reasoning", "math", "analysis"])
    ap.add_argument("--model", default=os.environ.get("SWARM_MODEL", "unknown"))
    ap.add_argument("--gpu", default=os.environ.get("SWARM_GPU", ""))
    ap.add_argument("--vram", type=int, default=int(os.environ.get("SWARM_VRAM", "0")))
    ap.add_argument("--max-context", type=int, default=int(os.environ.get("SWARM_MAX_CONTEXT", "8192")))
    ap.add_argument("--speed", default=os.environ.get("SWARM_SPEED", ""))
    ap.add_argument("--share-ratio", type=int, default=int(os.environ.get("SWARM_SHARE_RATIO", "100")),
                    help="產能貢獻比率 % (0-100)。idle 誘獎同派工優先度按此比例縮減（防蜂擁）。查額時會顯示計法。")
    ap.add_argument("--port", default=5900, type=int)
    ap.add_argument("--listen", default="0.0.0.0")
    ap.add_argument("--n-predict", type=int, default=128)
    ap.add_argument("--heartbeat", type=int, default=0, help="heartbeat interval sec (0=off)")
    ap.add_argument("--pull", action="store_true", help="pull-mode: 唔使 inbound，poll router /tasks/poll 攞任務（NAT 後安全）")
    args = ap.parse_args()
    if not args.completion:
        print("--completion 必填（llama-server /completion URL）或 用 SWARM_COMPLETION env", file=sys.stderr)
        sys.exit(1)
    if not args.token:
        print("--token / SWARM_API_TOKEN 必填（router 認證）", file=sys.stderr)
        sys.exit(1)

    worker = Worker(args)
    if args.speed:
        worker.info["speed"] = args.speed
    else:
        worker.info["speed"] = _auto_bench(args)
    worker.args.speed = worker.info["speed"]
    if not worker.register():
        sys.exit(1)

    if args.pull:
        # pull-mode: 無需 inbound；淨係 outbound polls router
        print(f"[worker] PULL-mode (NAT-safe): polling {args.router}/tasks/poll every 3s")
        _poll_loop(worker)
        return

    httpd = ThreadingHTTPServer((args.listen, args.port), make_handler(worker))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"[worker] serving :{args.port} (beacon/assign)")

    if args.heartbeat > 0:
        while True:
            worker.heartbeat_once()
            time.sleep(args.heartbeat)
    else:
        # 保持 serve（beacon/assign 需長住）
        threading.Event().wait()


if __name__ == "__main__":
    main()