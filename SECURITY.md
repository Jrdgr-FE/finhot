# 安全问题

发现安全问题（比如能绕过后台登录、读到别人提交的反馈、让服务器去抓内网地址、泄露密钥），请不要开公开 issue，用 GitHub 的 [私下报告](https://github.com/Jrdgr-FE/finhot/security/advisories/new) 告诉我们，写清楚：

- 影响哪个部分（api、worker、web、Cloudflare Worker）和哪个版本（提交号）
- 复现步骤
- 可能造成的影响

我们会尽快回复。修复发布之前请不要公开细节。

只支持 `main` 分支的最新版本。自己部署的站点请定期 `git pull` 更新。

## 部署时的基本要求

- `ADMIN_PASSWORD` 至少 12 位，`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、同步和回源令牌用 `openssl rand -hex 32` 生成。
- 生产环境不要设 `DEV_AUTH_ROLE` 和 `ALLOW_PRIVATE_NETWORK_FETCH`（程序会拒绝启动）。
- 网站直接对外时保持 `TRUST_PROXY=false`；只有前面有自己的反向代理时才设为 `true`。
- 数据库端口不要对公网开放。
