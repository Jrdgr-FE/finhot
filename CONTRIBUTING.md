# 参与 FinHot

欢迎提 issue 和 PR。动手前先读 [AGENTS.md](AGENTS.md)：里面的规则对人和 Agent 一样适用。

## 本机准备

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
createdb finhot_test                                   # 名字必须以 _test 或 _ci 结尾，测试会清空它
export DATABASE_URL=postgres://127.0.0.1:5432/finhot_test
node scripts/migrate.ts
```

跑站点见 [部署 → 不用 Docker](docs/deploy.md#不用-docker)。开发时把 `.env` 里的 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 设为 `false`，就不会抓信源、不会花模型的钱。

## 提交前

```bash
npm run typecheck
npm test
npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
npm run free:check && npm run free:test               # 改了 deploy/ 时
```

PR 会在 GitHub Actions 里跑同样的检查，外加一次 `docker compose up` 的冒烟测试。测试不访问任何外部服务，也不需要任何 key。

## 改什么放在哪里

| 想改的 | 位置 | 说明 |
|---|---|---|
| 信源 | `industry/sources.json` | 见 [信源](docs/sources.md)。默认只展示摘要和原文链接，来源明确允许才开全文 |
| 什么算重要、什么算噪声 | `industry/prompts/selection-score*.md` | 保留原有结构，只换例子；附上在标注样本上的评测（[精选与校准](docs/selection.md)） |
| 门槛 | `industry/selection.ts` | 用标注样本重新校准，不凭感觉改数字 |
| 不调模型就能判断的例行内容 | `industry/prescreen.ts` | 改规则时在 `tests/prescreen.test.ts` 里加上对应的标题例子 |
| 分类、实体、领域 | `industry/taxonomy.ts`、`industry/domains.ts` | |
| 数据库 | `database/migrations/` | 只做向后兼容的增量，新文件按编号加在末尾 |

## 不要提交

`.env`、`.dev.vars`、`.data/`、任何密钥和密码、服务器地址、Cloudflare 账号和数据库 ID。运维记录放在仓库外面。

## 代码风格

匹配周围代码的写法、命名和注释密度。选能清楚解决问题的简单方案，只定义正在用的抽象。
