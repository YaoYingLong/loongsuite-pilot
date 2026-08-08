#!/bin/bash
# `detect_init_system()` 的 Docker 测试入口：构建一个镜像并在单个容器内运行全部场景。
# 它只挂载测试代码，不接触宿主机的 systemd/launchd；docker build/run 任一步失败即返回非零退出码。
#
# 用法：./scripts/e2e/test-detect-init-system.sh
#
# 严格模式解释：`-e` 命令失败退出，`-u` 未定义变量退出，`pipefail` 让管道中间失败可见。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMAGE_NAME="detect-init-test"

echo "============================================"
echo " detect_init_system() Scenario Tests"
echo "============================================"
echo ""
echo "[build] Building test image..."

docker build -t "$IMAGE_NAME" -f - "$REPO_ROOT" <<'DOCKERFILE'
FROM ubuntu:22.04
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g; s|http://ports.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    systemd sudo bash coreutils procps \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m testuser && echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
RUN useradd -m nopwduser && echo "nopwduser ALL=(ALL) ALL" >> /etc/sudoers
COPY scripts/e2e/test-detect-init-runner.sh /opt/run-tests.sh
RUN chmod +x /opt/run-tests.sh
DOCKERFILE

echo "[build] Done."
echo ""

docker run --rm "$IMAGE_NAME" /opt/run-tests.sh
