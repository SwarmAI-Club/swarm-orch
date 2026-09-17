#! /usr/bin/env python3
"""SwarmAI Notebook MCP 對接 stub（JSON-RPC over stdio，MCP 形狀）.

Notebook 前端經標準輸入輸出，用 MCP 風格工具調用 Router（提交任務 / 查節點 / 查 credit）。
本 stub 先以 JSON-RPC 2.0 實作 `tools/list` + `tools/call`；之後可原樣夾入 FastMCP 包裝。

用法:
  printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nodes.list","arguments":{}}}\n' \
    | python3 notebook/mcp_server.py
"""
import json, os, sys

import requests

ROUTER = os.environ.get("SWARM_ROUTER", "http://100.70.76.100:4900")

TOOLS = {
    "nodes.list": {
        "description": "列出已註冊嘅 swarm 節點 + 最後 heartbeat",
        "call": lambda args: requests.get(f"{ROUTER}/nodes", timeout=10).json(),
    },
    "credits.get": {
        "description": "查某 node 嘅 Time-Bank credit balance",
        "call": lambda args: requests.get(f"{ROUTER}/credits/{args['node_id']}", timeout=10).json(),
    },
    "task.beacon": {
        "description": "向 swarm 廣播任務，等 worker 應戰（唔會洩漏私密：先喺前端過 privacy filter）",
        "call": lambda args: requests.post(f"{ROUTER}/beacon", json={
            "task": args["task"], "required_capabilities": args.get("capabilities", ["reasoning"]),
        }, timeout=15).json(),
    },
}


def handle(msg):
    method = msg.get("method", "")
    if method == "tools/list":
        return {"tools": [{"name": k, "description": v["description"]} for k, v in TOOLS.items()]}
    if method == "tools/call":
        name = msg.get("params", {}).get("name")
        args = msg.get("params", {}).get("arguments", {}) or {}
        t = TOOLS.get(name)
        if not t:
            return {"error": {"code": -32601, "message": f"tool not found: {name}"}}
        try:
            return {"result": t["call"](args)}
        except Exception as e:
            return {"error": {"code": -32000, "message": str(e)}}
    return {"error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            print(json.dumps({"jsonrpc": "2.0", "error": {"code": -32700, "message": str(e)}}))
            continue
        resp = {"jsonrpc": "2.0", "id": msg.get("id")}
        resp.update(handle(msg))
        print(json.dumps(resp, ensure_ascii=False))
        sys.stdout.flush()


if __name__ == "__main__":
    main()