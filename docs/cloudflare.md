# 用 Cloudflare 做前台

最简单的部署是 [Docker Compose 一台机器跑整站](deploy.md)。finhot.fun 用的是另一种做法：采集、模型和数据库留在自己的服务器上，公开页面放到 Cloudflare Workers，读者访问不经过服务器。这份文档说明怎么搭一套同样的。

## 三种前台

`deploy/` 里有三种 Cloudflare 前台，用的是同一套静态页面（`deploy/free/public/`），区别在数据从哪里来：

| 方式 | 配置文件 | 数据从哪里来 | 适合 |
|---|---|---|---|
| **同步**（finhot.fun 在用） | `deploy/ecs/cloudflare-sync.jsonc` + `cloudflare-sync-gateway.jsonc` | 服务器每 2 分钟把公开结果推到 D1 | 服务器不对公网开放，也不怕服务器短暂停机 |
| **回源** | `deploy/ecs/cloudflare-hybrid.jsonc` | 每个请求经 Worker 转发到服务器的 `/_edge/*` | 服务器能对外提供 HTTPS，想少一套 D1 |
| **全托管** | `deploy/free/wrangler.jsonc` | Worker 自己定时抓信源、用 Workers AI 写摘要，存在 D1 | 没有服务器、量很小的试用站；能力比服务器版少很多 |

下面主要讲同步方式，另外两种在文末。

## 同步方式

```
服务器（PostgreSQL · api · worker）
   │ finhot-sync.timer 每 2 分钟：deploy/ecs/push-public.ts
   ▼  HTTPS + SYNC_TOKEN
同步 Worker（sync.example.com，只接受 /_sync/*）
   │ 写入
   ▼
D1（公开资料、日报、信源、反馈）
   ▲ 只读
公开 Worker（example.com，静态页面 + /api/* /articles/* /daily/* /feed.xml …）──► 读者
```

- 推送的只是公开读取层（`packages/backend/src/publication/edge.ts`）给出的结果：标题、摘要、分类、链接、日报。原文正文、模型回执、采集凭据都不会离开服务器。
- 推送是增量的：只传有变化的条目，每批先 `begin`，分块 `items`，最后 `commit` 原子切换；中途断了下次接着传，不会重传整份。
- 公开 Worker 设了 `PUBLIC_ONLY=true`，不接受 `/_sync/`；同步 Worker 设了 `SYNC_ONLY=true`，只接受 `/_sync/`。两者共用一个 D1。
- 服务器超过 15 分钟没推送时，公开 Worker 继续提供上一份完整数据，并在 `/admin` 的状态里记一条事件（每 10 分钟检查一次）。

### 1. 准备服务器

服务器按 [部署](deploy.md) 里“不用 Docker”的方式跑 api、worker、web 三个进程（也可以用 Docker，只要同步脚本能连上数据库）。`deploy/ecs/` 里有 finhot.fun 用的 systemd 单元，假定的目录是：

| 位置 | 内容 |
|---|---|
| `/opt/finhot/releases/<版本>` | 每次发布解压一份，`/opt/finhot/current` 指向当前版本 |
| `/opt/finhot/runtime/bin/node` | Node.js 24 |
| `/etc/finhot/{api,worker,web,sync,backup}.env` | 每个进程自己的环境变量，属主 root、组 finhot、权限 640 |
| `/var/lib/finhot` | 数据目录（`AIHOT_DATA_DIR`）、同步状态、本地备份 |

`deploy/ecs/bootstrap.py` 能在一台装好 PostgreSQL 的新机器上建 `finhot` 用户、数据库和这几个 env 文件（随机生成数据库密码和会话密钥，模型调用和采集默认关闭），用法见文件开头。路径和域名不同就照着改，或者直接手写 env 文件。

每个进程要哪些变量见 [`.env.example`](../.env.example)。注意：

- api、worker 都要 `DATABASE_URL`、`IMG_PROXY_SIGN_SECRET`；api 还要 `ADMIN_PASSWORD`、`SESSION_SECRET`。
- 模型的 key 只放在 worker 的 env 里。
- 确认一切正常后再把 worker 的 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 改成 `true`。

### 2. 建 D1 和两个 Worker

在本机仓库目录里登录 Cloudflare（`npx wrangler login`），然后：

```bash
npx wrangler d1 create finhot-public-sync
```

把输出里的 `database_id`，连同你的账号 ID、域名所在 zone 的 ID，填进 `deploy/ecs/cloudflare-sync.jsonc` 和 `cloudflare-sync-gateway.jsonc` 里对应的 `<CLOUDFLARE_ACCOUNT_ID>`、`<CLOUDFLARE_ZONE_ID>`、`<D1_DATABASE_ID>`，并把 `finhot.fun`、`sync.finhot.fun` 换成你的域名。这些 ID 不是密钥，但也没必要公开，自己的 fork 里可以放心填。

建表：

```bash
npx wrangler d1 migrations apply finhot-public-sync --remote -c deploy/ecs/cloudflare-sync.jsonc
```

设置密钥（只用 `wrangler secret put`，不要写进 jsonc）：

```bash
openssl rand -hex 32        # 生成同步令牌，下面两处和服务器上用同一个
npx wrangler secret put SYNC_TOKEN     -c deploy/ecs/cloudflare-sync-gateway.jsonc
npx wrangler secret put ADMIN_PASSWORD -c deploy/ecs/cloudflare-sync.jsonc        # 前台 /admin 状态页用，至少 12 位
```

构建页面并发布：

```bash
node deploy/ecs/build-front.mjs        # 生成 .data/build/hybrid/public
npx wrangler deploy -c deploy/ecs/cloudflare-sync-gateway.jsonc
npx wrangler deploy -c deploy/ecs/cloudflare-sync.jsonc
```

`build-front.mjs` 里写着页面标题、说明和 canonical 地址（`https://finhot.fun/`），换站名或域名时一起改。条款和隐私说明取自 `industry/pages/hybrid-*.md`，上线前请换成你自己的。

### 3. 在服务器上开启推送

`/etc/finhot/sync.env`：

```bash
DATABASE_URL="postgres://finhot:…@127.0.0.1:5432/finhot"
FINHOT_SYNC_URL="https://sync.example.com/"     # 同步 Worker 的根地址，只写到 /
FINHOT_SYNC_TOKEN="…"                           # 与 Worker 的 SYNC_TOKEN 相同，至少 32 位
FINHOT_SYNC_STATE="/var/lib/finhot/public-sync-state.json"
# 公开站除了金融，还展示哪些领域（与 worker 保持一致）：
# FINHOT_PUBLIC_DOMAINS=ai
```

```bash
sudo cp deploy/ecs/finhot-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start finhot-sync.service && journalctl -u finhot-sync.service -n 20   # 先手动推一次
sudo systemctl enable --now finhot-sync.timer
```

第一次推送会传所有公开条目，之后每次只传变化。输出 `{"unchanged":true,…}` 表示没有新内容，只更新了心跳。

### 4. 检查

- 打开 `https://example.com/api/health`，`stale` 应为 `false`。
- `https://example.com/admin` 用 `ADMIN_PASSWORD` 登录，能看到同步状态、预算、信源和最近的反馈。
- `https://sync.example.com/` 之外的路径都应返回 404；`https://example.com/_sync/head` 也应返回 404。

### 其他文件

| 文件 | 作用 |
|---|---|
| `cloudflare-sync-preview.jsonc` | 同一个 D1 的内部预览站（`PREVIEW_ONLY=true`，整站要管理员密码） |
| `cloudflare-redirect.jsonc`、`redirect-worker.ts` | 把 `www.`、旧域名和 http 跳到主域名，域名写在 `redirect-worker.ts` 里 |
| `finhot-backup.{service,timer}`、`backup.sh` | 每天 04:10 UTC 用 `pg_dump` 做本地备份并校验，保留 7 天 |
| `package.mjs` | 把仓库打成发布包（排除 `.env`、`.data`、`node_modules`） |
| `stage.py`、`update-release.py` | 先在备用端口试跑候选版本，确认后切换 `/opt/finhot/current` 并保留回滚 |

## 回源方式

公开 Worker 收到 `/api/items`、`/api/reports`、`/feed.xml` 这类请求时，转发到服务器的 `/_edge/*`，带上 `x-finhot-origin-token` 请求头；服务器的 api 只认这个令牌。

1. 服务器 api 的 env 里加 `FINHOT_ORIGIN_TOKEN`（`openssl rand -hex 32`），并让 `https://api.example.com/_edge/*` 能从公网访问（只需要这个前缀）。
2. 改 `deploy/ecs/cloudflare-hybrid.jsonc` 的账号 ID、`SITE_URL` 和 `BACKEND_ORIGIN`（只写到 `/`）。
3. `npx wrangler secret put BACKEND_TOKEN -c deploy/ecs/cloudflare-hybrid.jsonc`（与 `FINHOT_ORIGIN_TOKEN` 相同），再设 `ADMIN_PASSWORD`。
4. `node deploy/ecs/build-front.mjs && npx wrangler deploy -c deploy/ecs/cloudflare-hybrid.jsonc`。

服务器停机时公开站也读不到数据，这是它和同步方式最大的区别。

## 全托管方式

`deploy/free/` 是一个完全跑在 Cloudflare 上的简化版：Worker 每 10 分钟抓一轮信源，用 Workers AI 一次写出标题、摘要、分类和分数（每天最多 `AI_DAILY_LIMIT` 条），存进 D1，每天生成一份简单的日报。PDF 只解析 1 MB 以内的，没有两次评分、规则预筛和事件归组。

```bash
npx wrangler d1 create finhot-free              # 把 ID 填进 deploy/free/wrangler.jsonc
npx wrangler queues create finhot-free-tasks
npx wrangler d1 migrations apply finhot-free --remote -c deploy/free/wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD -c deploy/free/wrangler.jsonc
npm run free:deploy
```

本机试：`npm run free:dev`（不抓信源、不调模型）。检查和测试：`npm run free:check`、`npm run free:test`。

## 不要提交的东西

- `.env`、`/etc/finhot/*.env`、`deploy/free/.dev.vars`：这些都已在 `.gitignore` 里。
- 令牌和密码只通过 `wrangler secret put` 或服务器上的 env 文件设置。
- 服务器地址、SSH 命令这类运维记录放在仓库外面。
