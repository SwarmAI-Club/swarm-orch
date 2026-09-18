#!/bin/bash
# SwarmAI sandbox worker runner — GPU-only container, read-only FS
# Usage: SWARM_ROUTER=... SWARM_COMPLETION=... bash sandbox/run-worker.sh rtx2080ti "reasoning math code"
set -e
NODE_ID="${1:-$(hostname)}"
CAPS="${2:-reasoning math analysis}"
ROUTER="${SWARM_ROUTER:-http://100.70.76.100:4900}"
COMPLETION="${SWARM_COMPLETION}"
GPU="${SWARM_GPU:-}"
MODEL="${SWARM_MODEL:-unknown}"

[ -n "$COMPLETION" ] || { echo "SWARM_COMPLETION 必填"; exit 1; }

cd "$(dirname "$0")/.."
if ! docker image inspect swarm-worker >/dev/null 2>&1; then
  echo "[sandbox] building image..."
  docker build -q -f sandbox/Dockerfile -t swarm-worker .
fi

echo "[sandbox] starting worker $NODE_ID (capabilities: $CAPS)"
exec docker run --rm -d --name "swarm-worker-$NODE_ID" \
  --gpus "${GPU:-all}" \
  --network bridge \
  --add-host host.docker.internal:host-gateway \
  --read-only --tmpfs /tmp \
  -e SWARM_ROUTER="$ROUTER" \
  -e SWARM_COMPLETION="$COMPLETION" \
  -e SWARM_GPU="$GPU" -e SWARM_MODEL="$MODEL" \
  -e SWARM_API_TOKEN="$SWARM_API_TOKEN" \
  swarm-worker python worker.py \
  --router "$ROUTER" --completion "$COMPLETION" \
  --token "$SWARM_API_TOKEN" --pull \
  --node-id "$NODE_ID" --capabilities $CAPS --model "$MODEL" --gpu "$GPU" \
  --speed "${SWARM_SPEED:-}" --share-ratio "${SWARM_SHARE_RATIO:-100}"