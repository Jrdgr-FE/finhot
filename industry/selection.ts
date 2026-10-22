// 精选的门槛。评分标准本身写在 prompts/selection-score*.md；这里只决定“多少分算入选”。
// 每篇资料由评分模型打分（0–100）：第一次分离门槛超过 secondScoreMargin 时就由这一次决定；离门槛近的
// 再独立打第二次，取平均。平均分 ≥ 门槛才进精选，卡片上显示平均分。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些。改了门槛或评分提示词，
// 用 scripts/eval-selection.ts 在你自己标注的样本上重跑一遍，再决定上线（见 docs/selection.md）。

const FINANCE = { T1: 60, T1_5: 65, T2: 76 } as Record<string, number>;

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（官网、官方博客、机构）· T1_5 官方账号、准官方创作者 · T2 媒体与个人
   * 分级 EXCLUDE_MP 以及这里没有列出的分级，不参与精选评分（只进“全部动态”）。
   * 这一组是金融领域的门槛（加领域之前的写法，留给旧代码和评测脚本）。
   */
  thresholds: FINANCE,
  /**
   * 按资料的主领域取门槛（industry/domains.ts）。AI 与硬科技暂用 AIHOT 在 AI 领域的原值，
   * 用这个领域自己标注的样本集校准后再改（docs/selection.md）。
   */
  byDomain: {
    finance: FINANCE,
    ai: { T1: 60, T1_5: 65, T2: 76 },
  } as Record<string, Record<string, number>>,
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由、标签）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
  /**
   * 第一次分离门槛在这个分差以内，才打第二次分。按 2026-09-21 至 10-21 的 1,199 篇两次打分回测：
   * 10 分时省掉 82% 的第二次打分，入选结果一篇不变（scripts/backtest-prescreen.ts）。
   */
  secondScoreMargin: 10,
} as const;
