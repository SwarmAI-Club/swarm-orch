"""SwarmAI worker node — Python. 對接 llama-server /completion endpoint."""
import argparse, json, os, sys, time, uuid, requests

def llm_complete(completion_url, prompt, n_predict=512, temperature=0.6):
    r = requests.post(
        completion_url,
        json={
            "prompt": f"{prompt}\n\nASSISTANT:",
            "n_predict": n_predict,
            "temperature": temperature,
            "stop": ["<|im_end|>"],
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json().get("content", "").strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--router", default=os.environ.get("SWARM_ROUTER", "http://100.70.76.100:4900"))
    ap.add_argument("--node-id", default=os.environ.get("HOSTNAME", "node-" + uuid.uuid4().hex[:6]))
    ap.add_argument("--completion", required=True, help="llama-server /completion URL")
    ap.add_argument("--capabilities", nargs="*", default=["reasoning", "math", "analysis"])
    ap.add_argument("--port", default=5900, type=int)
    ap.add_argument("--listen", default="0.0.0.0")
    args = ap.parse_args()

    data = {
        "type": "node_register",
        "node_id": args.node_id,
        "capabilities": args.capabilities,
        "model": os.environ.get("SWARM_MODEL", "unknown"),
        "gpu": os.environ.get("SWARM_GPU", ""),
        "max_context": int(os.environ.get("SWARM_MAX_CONTEXT", 8192)),
        "speed": os.environ.get("SWARM_SPEED", ""),
        "url": f"http://{args.listen}:{args.port}",
    }
    try:
        requests.post(args.router.rstrip("/") + "/register", json=data, timeout=10)
        print(f"[worker] registered {args.node_id} -> {args.router}")
    except Exception as e:
        print(f"[worker] register FAIL: {e}")

if __name__ == "__main__":
    main()