#!/bin/bash
# Cloudflare Containers 的启动脚本。
#
# 一个容器里同时跑 web + api + worker 三个进程，理由是计费：Cloudflare Containers 按
# 「实例 × 运行时长」收内存费，起三个容器等于付三份。而 apps/web/server.ts 本来就会把
# API 路径反向代理到 api 进程（见该文件顶部注释），所以对外只需要暴露 3000 一个端口。
#
# 数据库迁移和种子放在这里跑，而不是像 docker-compose.yml 那样单独一个 setup 容器：
# Cloudflare Containers 没有「跑完就退出」的服务形态，实例睡醒后会重新执行 entrypoint，
# 所以这两步必须幂等。实际上它们本来就是——migrate 用 schema_migrations 表记账，
# seed 是 upsert。
set -euo pipefail
pids=()

shutdown() {
	trap - TERM INT
	echo "[finhot] 正在等待子进程安全退出"
	for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
	for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap 'shutdown; exit 0' TERM INT

echo "[finhot] 应用数据库迁移"
node scripts/migrate.ts

echo "[finhot] 导入种子数据"
node scripts/seed.ts

# 先起 api 和 worker：web 启动时会把 API 路径代理到 3001，api 没起来的话前几个请求会 502。
echo "[finhot] 启动 api (3001)"
node apps/api/src/main.ts &
API_PID=$!
pids+=("$API_PID")

echo "[finhot] 启动 worker（信源抓取与模型任务）"
node apps/worker/src/main.ts &
WORKER_PID=$!
pids+=("$WORKER_PID")

# 容器收到 TERM 时，把信号转给子进程，让 worker 有机会把在飞的付费模型调用做完
# （apps/worker 自己处理 SIGTERM，见 worker 的 STOP_TIMEOUT_MS 逻辑）。

echo "[finhot] 启动 web (3000)"
node apps/web/server.ts &
WEB_PID=$!
pids+=("$WEB_PID")

# 任一进程退出就整体退出，交给 Cloudflare 重启实例。比带着半死不活的进程继续对外服务要好：
# 比如 worker 崩了但 web 还在，访客看到的是一个永远不更新的站。
wait -n "$API_PID" "$WORKER_PID" "$WEB_PID" || true
echo "[finhot] 有进程退出，容器即将重启"
shutdown
exit 1
