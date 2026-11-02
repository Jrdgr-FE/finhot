import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedRepresentatives, type FoldRow } from '../packages/backend/src/events/fold.ts';

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
