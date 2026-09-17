# SwarmAI worker sandbox image
# Build context = swarm-orch/  (docker build -f sandbox/Dockerfile .)
#
# Security design (Zero-Knowledge Sandbox v1):
#  - 淨係 Python worker code + requests
#  - Host FS 唔 mount（--read-only --tmpfs /tmp）
#  - 網絡只去 router + completion endpoint（--network host，靠 firewall 限）
#  - GPU 只靠 --gpus 授權
FROM python:3.11-slim
RUN pip install --no-cache-dir requests
WORKDIR /srv
COPY worker-node/worker.py /srv/worker.py
EXPOSE 5900
CMD ["python", "worker.py"]