# FinHot

**金融人的每日信息台：自动盯盘公告、监管与研报，用大模型挑出真正重要的，写成中文摘要，每天早上 8 点出一份日报。**

线上站点：[finhot.fun](https://finhot.fun) · 配套的产业与公司图谱：[map.finhot.fun](https://map.finhot.fun)

## 为什么做 FinHot

金融信息的问题不是少，而是太多、太散、太吵：交易所公告、央行和监管的发布、统计局数据、券商研报、财经快讯，同一件事被转几十遍，真正影响判断的几条却容易被淹没。

FinHot 想做的是一个替你先读一遍的编辑：

- **一手信源优先。** 63 个信源，从中国证监会、国家统计局、上交所、巨潮资讯，到美联储、欧洲央行、国际清算银行，再到华尔街见闻、东方财富研报、21 世纪经济报道、CNBC。
- **按金融的逻辑分类。** 政策监管、宏观数据、市场行情、财报业绩、公司事件、投资研究，以及银行、证券、保险、资管、机构动态，共 11 类。
- **按投资者的标准精选。** 评分标准写明了什么算重要：会改变规则、数据或公司基本面的消息排在前面；只复述行情的、把评级目标价当结论的，会被压下去。
- **事实和预测分开。** 摘要会区分已经发生的事和机构的预测，不把原文没说的公司写进标题。
- **同一件事只看一次。** 不同来源对同一事件的报道会合并成一个事件，热度按独立来源数计算。

## 主要功能

| | |
|---|---|
| **金融分类与实体库** | 11 个金融分类，内置人民银行、金融监管总局、证监会、外汇局、三大交易所、主要银行等实体及别名，标签统一 |
| **双领域** | 金融之外，还可以打开「AI 与硬科技」领域（模型、芯片与半导体、算力、机器人与具身智能等），每个领域有自己的评分标准、门槛和日报，一条资料可以同时属于两个领域 |
| **日报** | 北京时间每天 08:00 生成，按板块分节，带导语和来源索引 |
| **中英双语** | 公开站点默认英文、可切换中文，可选为精选内容生成英文标题与摘要 |
| **PDF 正文** | 交易所公告、研报这类 PDF 会提取正文后再交给模型 |
| **成本可控** | 模型调用按每小时次数和滚动 24 小时金额双重限额，超额自动暂停，历史资料只建索引、不花钱 |
| **轻量前台** | 公开页面跑在 Cloudflare Workers + D1 上，访客请求不回源服务器、不触发模型 |
| **给 Agent 用** | RSS、公开 API、MCP、`llms.txt` |

## 架构

```
信源 ──► 服务器（采集 · 正文/PDF 提取 · 模型筛选与摘要 · 事件聚合 · 日报 · PostgreSQL）
                       │ 每 2 分钟推送公开结果
                       ▼
          Cloudflare Workers + D1（公开页面、搜索、RSS、日报）──► 读者
```

也可以不用 Cloudflare，整站用 Docker Compose 跑在一台机器上。

技术栈：Node.js 24 · TypeScript · React Router · Fastify · PostgreSQL · pg-boss · Cloudflare Workers / D1 · Docker Compose。

## 跑起来

需要 [Docker](https://docs.docker.com/get-docker/) 和一个 OpenAI 兼容的模型 API Key（DeepSeek、千问、智谱都可以）。

```bash
git clone https://github.com/Jrdgr-FE/finhot.git
cd finhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
docker compose up -d --build
```

打开 <http://localhost:3000>，后台在 `/admin`，管理员密码在 `.env` 的 `ADMIN_PASSWORD` 里。所有配置项见 [`.env.example`](.env.example)。`.env` 已被忽略，不会被提交。

### 和 finhot.fun 一样，用 Cloudflare 做前台

1. 把 `deploy/ecs/*.jsonc` 和 `deploy/free/wrangler.jsonc` 里的 `<CLOUDFLARE_ACCOUNT_ID>`、`<CLOUDFLARE_ZONE_ID>`、`<D1_DATABASE_ID>`、`<your-subdomain>` 和域名换成你自己的（`npx wrangler d1 create <名字>` 会给出 D1 ID）。
2. 密钥只用 `npx wrangler secret put <名字>` 设置（如 `SYNC_TOKEN`、`ADMIN_PASSWORD`），不要写进配置文件。
3. 服务器上的同步进程用 `FINHOT_SYNC_URL` 和 `FINHOT_SYNC_TOKEN`（与 Worker 的 `SYNC_TOKEN` 相同，至少 32 位）推送公开结果。systemd 单元在 `deploy/ecs/*.service`，从 `/etc/finhot/<角色>.env` 读配置。

## 定制

信源、分类、精选标准和文案几乎都在 [`industry/`](industry/) 里，改它们基本不用动代码：

| 文件 | 内容 |
|---|---|
| `sources.json` | 信源列表 |
| `taxonomy.ts`、`domains.ts` | 分类、实体库、领域开关 |
| `prompts/` | 评分标准与写作要求，`*.ai.md` 是 AI 与硬科技领域的版本 |
| `selection.ts`、`prescreen.ts` | 入选门槛与预筛规则 |
| `site.ts`、`brand/`、`pages/` | 站名、文案、图标、使用规则与隐私说明 |

更多说明：[定制](docs/customize.md) · [信源](docs/sources.md) · [精选与校准](docs/selection.md) · [部署](docs/deploy.md) · [架构](docs/architecture.md)

## 致谢

FinHot 基于 [AIHOT](https://github.com/KKKKhazix/AIHOT)（作者 数字生命卡兹克，MIT 许可）的开源框架开发，采集、评分、聚类和热度算法的基础来自这个项目，感谢原作者。

## 许可

代码使用 [MIT 许可证](LICENSE)。FinHot 与 AIHOT 的名称和标志不在许可范围内，自己部署时请换上你自己的。字体与第三方标志的许可见 [NOTICE](NOTICE)。

---

<sub>**In English:** FinHot ([finhot.fun](https://finhot.fun)) is a finance news desk. It watches 63 primary and media sources (exchanges, regulators, central banks, statistics bureaus, broker research, financial press), lets a language model score and summarize each item, merges reports of the same event, ranks events by independent sources and publishes a daily briefing at 08:00 Beijing time. An optional AI & deep-tech domain runs alongside finance. The public site runs on Cloudflare Workers + D1; the pipeline runs on your own server. Built on the open-source AIHOT framework (MIT). Documentation is in Chinese.</sub>
