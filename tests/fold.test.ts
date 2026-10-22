import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLD_MIN_TITLE, feedRepresentatives, titleSimilarity, type FoldRow } from '../packages/backend/src/events/fold.ts';

const row = (id: string, at: string, extra: Partial<FoldRow> = {}): FoldRow =>
  ({ id, feed_cluster: null, story_id: null, selected: false, score: null, at: new Date(`2026-10-22T${at}:00+08:00`), ...extra });

test('one feed row per cluster: the first report found stands for unselected ones', () => {
  const shown = feedRepresentatives([
    row('a', '09:00'), row('b', '10:00', { feed_cluster: 'a' }), row('c', '11:00', { feed_cluster: 'a' }), row('d', '12:00'),
  ]);
  assert.deepEqual([...shown].sort(), ['a', 'd']);
});

test('a selected report stands for its cluster and its story, the highest score first', () => {
  const shown = feedRepresentatives([
    row('a', '09:00'), row('b', '10:00', { feed_cluster: 'a', story_id: 7, selected: true, score: 70 }),
    row('c', '11:00', { story_id: 7, selected: true, score: 82 }), row('d', '12:00', { story_id: 8, selected: true, score: 90 }),
  ]);
  assert.deepEqual([...shown].sort(), ['c', 'd']);
});

test('a report whose cluster head left the feed shows on its own', () => {
  assert.deepEqual([...feedRepresentatives([row('b', '10:00', { feed_cluster: 'gone' })])], ['b']);
});

test('title similarity: the same news in other words folds, template titles of different companies do not', () => {
  const titles = [
    '证监会发布《违规转让证券案件行政处罚实施规则》，2026年12月1日起施行', '中国证监会发布《违规转让证券案件行政处罚实施规则》',
    '长川科技预计2026年前三季度净利润同比增长98.17%至109.73%', '深南电路预计2026年前三季度净利润同比增长74.13%至78.43%',
    '宁德时代发布2026年三季度报告，前三季度营收4421.37亿元', '北化股份发布2026年三季度报告',
    '上交所召开首批主动ETF市场动员会，9家基金管理人、7家券商参会', '上交所召开首批主动ETF市场动员会，首批9家基金管理人及7家券商参会',
    '国家统计局：前三季度GDP同比增长4.6%', '美联储维持利率不变', '欧洲央行行长讲话', '英伟达发布新芯片', '易方达自购2亿元',
  ];
  const similar = titleSimilarity(titles);
  assert.ok(similar(0, 1) >= FOLD_MIN_TITLE);
  assert.ok(similar(6, 7) >= FOLD_MIN_TITLE);
  assert.ok(similar(2, 3) < FOLD_MIN_TITLE);
  assert.ok(similar(4, 5) < FOLD_MIN_TITLE);
});
