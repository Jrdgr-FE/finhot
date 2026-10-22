## 改了什么



## 为什么



## 怎么验证的

- [ ] `npm run typecheck`
- [ ] `npm test`（空的 `*_test` 库）
- [ ] `npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts`
- [ ] 改了 `deploy/` 时：`npm run free:check && npm run free:test`

## 检查

- [ ] 没有提交 `.env`、密钥、服务器地址或 Cloudflare 账号 ID
- [ ] 新迁移只做向后兼容的增量，编号加在 `database/migrations/` 末尾
- [ ] 改了评分标准或门槛时，附上在标注样本上的评测结果（`docs/selection.md`）
