#! /usr/bin/env python3
"""SwarmAI swarm-agent daemon — 客戶端守護進程（「第一段 DNA」）.

職責:
  1. 偵測本地時區 + 睡眠/空閒窗口（或手動 Share Mode）
  2. 上線時以 protocol v0.2 `node_register` 註冊
  3. 定期 `node_status` heartbeat 向 Router 佈告狀態（IDLE_SHARING / USER_OCCUPIED）
  4. 準備接收其他時區嘅 Agent 任務（mock 模式唔使真 GPU 都跑到）

用法:
  python3 agent/swarm_agent.py --config agent/agent.json
  python3 agent/swarm_agent.py --config agent/agent.json --mock --heartbeat 3
"""
import argparse, json, os, sys, time

try:
    import requests
except ImportError:
    print("need: pip install requests", file=sys.stderr)
    sys.exit(1)

try:
    from zoneinfo import ZoneInfo
    from datetime import datetime
    HAS_TZ = True
except Exception:
    from datetime import datetime
    HAS_TZ = False


def now_local(timezone=None):
    if HAS_TZ and timezone:
        return datetime.now(ZoneInfo(timezone))
    return datetime.now()


def is_sleep_window(start_hour, end_hour, timezone=None):
    """支援跨日窗口（如 22:00 -> 07:00）。"""
    dt = now_local(timezone)
    h = dt.hour
    if start_hour == end_hour:
        return False
    if start_hour < end_hour:
        return start_hour <= h < end_hour
    # 跨午夜
    return h >= start_hour or h < end_hour


def node_status_payload(cfg, sleeping):
    status = "IDLE_SHARING" if sleeping else "USER_OCCUPIED"
    return {
        "type": "node_status",
        "node_id": cfg["node_id"],
        "status": status,
        "vram_used_gb": cfg.get("vram_total_gb"),
        "model_loaded": cfg.get("model"),
        "load": None,
        "sleeping": sleeping,
        "ts": int(time.time()),
    }


def _headers(cfg):
    token = cfg.get("token") or os.environ.get("SWARM_API_TOKEN", "")
    h = {"content-type": "application/json"}
    if token:
        h["x-swarm-token"] = token
    return h


def register(cfg, router):
    data = {
        "type": "node_register",
        "node_id": cfg["node_id"],
        "capabilities": cfg.get("capabilities", ["reasoning"]),
        "model": cfg.get("model", "unknown"),
        "gpu": cfg.get("gpu", ""),
        "max_context": int(cfg.get("max_context", 8192)),
        "speed": cfg.get("speed", ""),
        "url": cfg.get("url", ""),
    }
    r = requests.post(router.rstrip("/") + "/register", json=data, headers=_headers(cfg), timeout=10)
    r.raise_for_status()
    return r.json()


def heartbeat(cfg, router, sleeping):
    r = requests.post(router.rstrip("/") + "/status", json=node_status_payload(cfg, sleeping),
                      headers=_headers(cfg), timeout=10)
    r.raise_for_status()
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--router", default=os.environ.get("SWARM_ROUTER", "http://100.70.76.100:4900"))
    ap.add_argument("--mock", action="store_true", help="唔 call completion，純測試 heartbeat")
    ap.add_argument("--heartbeat", type=int, default=0, help="heartbeat interval sec（>0 先啓動 loop；0 = 只註冊一次就退出）")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("node_id", "node-" + str(int(time.time())))
    share_mode = cfg.get("share_mode", "auto")          # auto | on | off
    sleep_start = int(cfg.get("sleep_start_hour", 0))
    sleep_end = int(cfg.get("sleep_end_hour", 7))
    tz = cfg.get("timezone")
    interval = args.heartbeat if args.heartbeat > 0 else 0

    # 註冊
    try:
        reg = register(cfg, args.router)
        print(f"[agent] {cfg['node_id']} registered -> {args.router} (nodes={reg.get('nodes')})")
    except Exception as e:
        print(f"[agent] register FAIL: {e}")
        if not args.mock:
            sys.exit(1)

    if interval <= 0:
        sleeping = is_sleep_window(sleep_start, sleep_end, tz)
        print(f"[agent] one-shot status: {'IDLE_SHARING 💤' if sleeping else 'USER_OCCUPIED ☀️'} (providing={cfg.get('vram_total_gb')}GB)")
        return

    print(f"[agent] daemon running (heartbeat={interval}s) — Ctrl+C 停")
    while True:
        # Share Mode: on 永遠 IDLE_SHARING；off 永遠 USER_OCCUPIED；auto 跟睡眠窗口
        if share_mode == "on":
            sleeping = True
        elif share_mode == "off":
            sleeping = False
        else:
            sleeping = is_sleep_window(sleep_start, sleep_end, tz)
        try:
            ht = heartbeat(cfg, args.router, sleeping)
            st = "IDLE_SHARING 💤" if sleeping else "USER_OCCUPIED ☀️"
            print(f"[agent] {cfg['node_id']} {st} ts={int(time.time())} ack={ht.get('ok')}")
        except Exception as e:
            print(f"[agent] heartbeat FAIL: {e}")
        time.sleep(interval)


if __name__ == "__main__":
    main()