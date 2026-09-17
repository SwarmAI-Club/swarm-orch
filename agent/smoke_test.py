#! /usr/bin/env python3
"""SwarmAI agent smoke test — spawn router, poll ready, register + heartbeat, assert.

用法: python3 agent/smoke_test.py
需要: node（router）、python3 + requests。
"""
import json, os, signal, subprocess, sys, time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # swarm-orch/
AGENT = os.path.join(ROOT, "agent")
ROUTER_JS = os.path.join(ROOT, "router", "router.js")
CONFIG_JSON = os.path.join(AGENT, "agent.json")
PORT = 5910
BASE = f"http://127.0.0.1:{PORT}"


def wait_ready(timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = requests.get(BASE + "/nodes", timeout=1)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def main():
    env = dict(os.environ)
    env["SWARM_ROUTER_PORT"] = str(PORT)
    proc = subprocess.Popen(
        ["node", ROUTER_JS],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_ready():
            print("FAIL: router未 ready", file=sys.stderr)
            return 1
        print("OK  router ready :", PORT)

        sys.path.insert(0, AGENT)
        import swarm_agent as A

        with open(CONFIG_JSON, encoding="utf-8") as f:
            cfg = json.load(f)
        cfg["node_id"] = "smoke-1"

        reg = A.register(cfg, BASE)
        print("OK  register   nodes:", reg.get("nodes"))

        # 一個睡眠窗口 + 一個非睡眠窗口
        sleep_p = A.node_status_payload({**cfg, "sleep_start_hour": 0, "sleep_end_hour": 23}, True)
        awake_p = A.node_status_payload({**cfg, "sleep_start_hour": 0, "sleep_end_hour": 23}, False)
        for pl in (sleep_p, awake_p):
            r = requests.post(BASE + "/status", json=pl, timeout=5)
            if r.status_code != 200 or not r.json().get("ok"):
                print("FAIL status", r.text, file=sys.stderr)
                return 1
        nodes = requests.get(BASE + "/nodes", timeout=5).json()
        mine = next((n for n in nodes if n.get("node_id") == "smoke-1"), None)
        if not mine or "last_status" not in mine:
            print("FAIL: 搵唔到 smoke-1 嘅 last_status", json.dumps(nodes), file=sys.stderr)
            return 1
        print("OK  heartbeat last_status:", mine["last_status"])
        print("ALL PASS")
        return 0
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())