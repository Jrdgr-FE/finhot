# FinHot / FinMap 产品界面

2026-10-28：FinHot 的资讯阅读和 FinMap 的公司研究使用同一套视觉规范。

- 深蓝顶栏 48 px、桌面侧栏 76 px；共用蓝色 F 标识与左上角产品切换菜单。
- 使用系统字体、蓝色操作强调、白色 / 深色内容面板、4–6 px 圆角和细分隔线。
- 资讯列表保留时间、来源与摘要；公司研究保留动态筛选、连续阅读、关注清单与产业图谱。
- 首页、资讯库、日报、文章详情、日报归档、关于、反馈和政策页面共用品牌与导航。
- 深浅模式是功能偏好；在 finhot.fun 的同域子站间保留，读取原 FinMap 偏好作为后备，不携带账号或研究数据。

规范源码在相邻 FinMap 仓库的 `public/fin-suite.css` 与 `public/fin-suite.js`；本站在 `deploy/free/public/` 保留完全相同的副本。同步命令为在 FinMap 目录执行 `node scripts/sync-suite.mjs ../finhot`。两站都从本域名加载资源，构建时不联网引用对方样式。

本站布局适配在 `deploy/free/public/style.css`，产品外框在 `terminal.js`。`i18n.js` 导入外框，兼容既有 Worker 文章页和日报归档，不需要为外框修改查询、预算或同步逻辑。发布说明见 `docs/finhot-suite-20261028.md`。
