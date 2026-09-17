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


def llm_complete(completion_url, prompt, n_predict=512, temperature=0.6):
    r = requests.post(
        completion_url,
        json={
            "prompt": f"{prompt}\n\nASSISTANT:",
            "n_predict": n_predict,
            "temperature": temperature,
            "stop": ["<|im_end|>"],
        },
        timeout=300,
    )
    r.raise_for_status()
    return r.json().get("content", "").strip()


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
            "url": f"http://{args.listen}:{args.port}",
        }

    def register(self, retries=3, delay=2):
        for i in range(retries):
            try:
                r = requests.post(self.args.router.rstrip("/") + "/register", json=self.info, timeout=10)
                print(f"[worker] registered {self.args.node_id} -> {self.args.router} ({r.json().get('nodes')} nodes)")
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
        votes = []
        t0 = time.time()
        for i in range(n_votes):
            content = llm_complete(self.args.completion, prompt, self.args.n_predict, temperature + (i * 0.05))
            votes.append({"content": content, "confidence": round(0.9, 3), "reasoning": ""})
        payload = {
            "type": "task_result", "task_id": body.get("task_id"),
            "node_id": self.args.node_id, "votes": votes,
            "duration_ms": int((time.time() - t0) * 1000),
        }
        try:
            requests.post(self.args.router.rstrip("/") + "/result", json=payload, timeout=20)
        except Exception as e:
            print(f"[worker] result post FAIL: {e}", file=sys.stderr)
        return {"ok": True, "votes": len(votes), "node_id": self.args.node_id}

    def heartbeat_once(self, sleeping=False):
        try:
            requests.post(self.args.router.rstrip("/") + "/status", json={
                "type": "node_status", "node_id": self.args.node_id,
                "status": "IDLE_SHARING" if sleeping else "USER_OCCUPIED",
                "vram_used_gb": self.args.vram, "model_loaded": self.args.model,
                "sleeping": sleeping, "ts": int(time.time()),
            }, timeout=10)
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--router", default=os.environ.get("SWARM_ROUTER", "http://100.70.76.100:4900"))
    ap.add_argument("--node-id", default=os.environ.get("HOSTNAME", "node-" + uuid.uuid4().hex[:6]))
    ap.add_argument("--completion", default=os.environ.get("SWARM_COMPLETION"), help="llama-server /completion URL")
    ap.add_argument("--capabilities", nargs="*", default=["reasoning", "math", "analysis"])
    ap.add_argument("--model", default=os.environ.get("SWARM_MODEL", "unknown"))
    ap.add_argument("--gpu", default=os.environ.get("SWARM_GPU", ""))
    ap.add_argument("--vram", type=int, default=int(os.environ.get("SWARM_VRAM", "0")))
    ap.add_argument("--max-context", type=int, default=int(os.environ.get("SWARM_MAX_CONTEXT", "8192")))
    ap.add_argument("--speed", default=os.environ.get("SWARM_SPEED", ""))
    ap.add_argument("--port", default=5900, type=int)
    ap.add_argument("--listen", default="0.0.0.0")
    ap.add_argument("--n-predict", type=int, default=128)
    ap.add_argument("--heartbeat", type=int, default=0, help="heartbeat interval sec (0=off)")
    args = ap.parse_args()
    if not args.completion:
        print("--completion 必填（llama-server /completion URL）或 用 SWARM_COMPLETION env", file=sys.stderr)
        sys.exit(1)

    worker = Worker(args)
    if not worker.register():
        sys.exit(1)

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