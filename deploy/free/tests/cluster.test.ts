import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterItems, clusterItemsWithMap, clusterReportItems, sameStory, type ClusterableItem } from '../../../packages/backend/src/publication/cluster.ts';

function makeItem(partial: Partial<ClusterableItem> & { id: string; title: string; source_id?: string; source_name?: string }): ClusterableItem {
  return {
    url: 'https://example.com/' + partial.id,
    source_id: partial.source_id ?? 'src-' + partial.id,
    source_name: partial.source_name ?? 'Source ' + partial.id,
    summary: partial.summary ?? '这是一段用于测试同题多源聚合的中文资讯摘要内容。',
    category: partial.category ?? 'ai-business',
    selected: partial.selected ?? 0,
    published_at: partial.published_at ?? '2026-11-08T18:00:00.000Z',
    discovered_at: partial.discovered_at ?? '2026-11-08T18:05:00.000Z',
    material_scope: partial.material_scope ?? '',
    ...partial,
  };
}

test('collapses multi-outlet Jensen Huang apology/probe stories while keeping unrelated Nvidia stories separate', () => {
  const items: ClusterableItem[] = [
    makeItem({
      id: 'eastmoney',
      source_id: 'eastmoney-news',
      source_name: '东方财富 · 财经要闻',
      title: '黄仁勋向英伟达员工发道歉信承认对妻子不忠，董事会就国家安全担忧启动独立调查',
    }),
    makeItem({
      id: 'bloomberg',
      source_id: 'bbg-markets',
      source_name: 'Bloomberg · Markets',
      title: '英伟达董事会就黄仁勋婚外情启动独立调查，涉及间谍疑云',
      original_title: 'Nvidia Board Probes CEO Huang Over Alleged Past Affair With Suspected Chinese Spy',
    }),
    makeItem({
      id: 'dcd',
      source_id: 'ai-dcd',
      source_name: 'DatacenterDynamics',
      title: '报道称英伟达CEO黄仁勋承认与被指中国间谍人士有私情，董事会将调查',
    }),
    makeItem({
      id: 'theinfo',
      source_id: 'ai-theinfo',
      source_name: 'The Information',
      title: '英伟达董事会启动独立调查，Anthropic IPO路演与CoreWeave财报将至',
    }),
    makeItem({
      id: 'nvidia-pr',
      source_id: 'ai-nvidia-news',
      source_name: 'NVIDIA · 新闻稿',
      title: '黄仁勋致员工信：为个人行为道歉，称英伟达董事会已就报道中的国家安全关切启动独立调查',
      original_title: 'A Message to Our Company',
    }),
    makeItem({
      id: 'techcrunch',
      source_id: 'ai-tc',
      source_name: 'TechCrunch · AI',
      title: '英伟达董事会启动独立调查，审查CEO黄仁勋与疑似中国间谍的关系',
    }),
    makeItem({
      id: 'cnbc',
      source_id: 'cnbc-markets',
      source_name: 'CNBC · Markets',
      title: '英伟达就CEO黄仁勋与涉嫌中国间谍女子关系展开调查',
    }),
    makeItem({
      id: 'nvidia-heist',
      source_id: '21jingji-company',
      source_name: '21世纪经济报道 · 公司',
      title: '英伟达AI芯片及硬件货物在美被盗 涉案价值1140万美元',
    }),
    makeItem({
      id: 'anthropic-story',
      source_id: 'wsj-tech',
      source_name: 'WSJ · Tech',
      title: 'Anthropic加速推进新一轮融资并筹备IPO路演，估值有望再创新高',
    }),
  ];

  const clustered = clusterItems(items);
  assert.equal(clustered.length, 3, '7 Jensen Huang items collapse to 1, while Nvidia chip heist and Anthropic story stay separate');
  const huangCluster = clustered[0];
  assert.equal(huangCluster.id, 'nvidia-pr', 'Official first-party release is preferred as representative');
  assert.equal(huangCluster.related_items?.length, 6);
  assert.deepEqual(
    clustered.map(c => c.id),
    ['nvidia-pr', 'nvidia-heist', 'anthropic-story']
  );
});

test('keeps templated series with different quantified numbers separate while merging verbatim reposts', () => {
  const mofcom1 = makeItem({
    id: 'm1',
    source_id: 'eastmoney',
    source_name: '东方财富 · 财经要闻',
    title: '商务部：自2026年11月10日起继续暂停对11家美国实体的不可靠实体清单措施2个月',
  });
  const mofcom2 = makeItem({
    id: 'm2',
    source_id: 'eastmoney',
    source_name: '东方财富 · 财经要闻',
    title: '商务部：自2026年11月10日起继续暂停实施对16家美国实体的出口管制管控名单措施2个月',
  });
  assert.equal(sameStory(mofcom1, mofcom2), false);

  const enflame1 = makeItem({
    id: 'e1',
    source_id: '21jingji',
    source_name: '21世纪经济报道 · 证券',
    title: '科创板日报｜“国产算力芯片四小龙”全线走强，燧原科技盘中拉升涨超17%',
  });
  const enflame2 = makeItem({
    id: 'e2',
    source_id: '21jingji',
    source_name: '21世纪经济报道 · 证券',
    title: '“国产算力芯片四小龙”全线走强，燧原科技盘中拉升涨超17%',
  });
  assert.equal(sameStory(enflame1, enflame2), true);
});

test('clusterReportItems backfills freed-up report slots from window candidates using distinct sources', () => {
  const reportItems = [
    makeItem({ id: 'h1', source_id: 's1', source_name: 'S1', title: '黄仁勋向英伟达员工发道歉信承认对妻子不忠，董事会就国家安全担忧启动独立调查' }),
    makeItem({ id: 'h2', source_id: 's2', source_name: 'S2', title: '英伟达董事会就黄仁勋婚外情启动独立调查，涉及间谍疑云' }),
    makeItem({ id: 'other1', source_id: 's3', source_name: 'S3', title: '高通在进博会展出端侧MoE智能体演示' }),
  ];
  const windowCandidates = [
    makeItem({ id: 'h3', source_id: 's4', source_name: 'S4', title: '报道称英伟达CEO黄仁勋承认与被指中国间谍人士有私情，董事会将调查' }),
    makeItem({ id: 'fill1', source_id: 's5', source_name: 'S5', title: '中科院空天院联合企业研发全栈国产化太空算力网' }),
  ];
  const { items } = clusterReportItems(reportItems, windowCandidates, 3);
  assert.equal(items.length, 3);
  assert.equal(items[0].related_items?.length, 2, 'Window duplicate h3 is folded into h1 instead of backfilled as a separate story');
  assert.equal(items[2].id, 'fill1', 'Freed slot is backfilled by distinct story fill1');
});

test('prevents false merges on generic sector bigrams, xAI vs SpaceX, and tangential conference follow-ups', () => {
  const xai = makeItem({
    id: 'xai',
    source_id: 's1',
    title: '马斯克称深度参与xAI孟菲斯数据中心配套发电厂建设',
  });
  const spacex = makeItem({
    id: 'spacex',
    source_id: 's2',
    title: 'SpaceX拟在德州投资240亿美元建设数据中心和燃气电厂',
  });
  assert.equal(sameStory(xai, spacex), false);

  const report = makeItem({
    id: 'rep',
    source_id: 's1',
    title: '国金证券研报：机器人景气度加速向上，关注人形机器人0-1节点',
  });
  const rally = makeItem({
    id: 'ral',
    source_id: 's2',
    title: 'A股人形机器人概念股早盘大涨，多股涨停',
  });
  assert.equal(sameStory(report, rally), false);

  const probe = makeItem({
    id: 'probe',
    source_id: 's1',
    title: '英伟达董事会就黄仁勋婚外情启动独立调查，涉及间谍疑云',
    summary: '英伟达董事会已聘请律所就黄仁勋婚外情与国家安全关切启动独立调查。',
  });
  const summit = makeItem({
    id: 'summit',
    source_id: 's2',
    title: '黄仁勋在公开信致歉后取消出席ElevenLabs AI峰会',
    summary: '在向员工发送致歉信并面临英伟达董事会关于婚外情的独立调查后，黄仁勋取消了ElevenLabs峰会行程。',
  });
  assert.equal(sameStory(probe, summit), false);
});

test('merges 3-item Google TPU cluster, Chinese numeral variants, and tracks exact consumedCount for pagination', () => {
  const tpu1 = makeItem({ id: 'g1', source_id: 's1', source_name: 'S1', title: '谷歌推出新款AI芯片，意在挑战英伟达' });
  const tpu2 = makeItem({ id: 'g2', source_id: 's2', source_name: 'S2', title: '谷歌推出两款新版TPU芯片，向英伟达发起新挑战' });
  const tpu3 = makeItem({ id: 'g3', source_id: 's3', source_name: 'S3', title: '谷歌推出两款新TPU芯片，加剧与英伟达竞争' });
  const ub1 = makeItem({ id: 'u1', source_id: 's1', source_name: 'S1', title: '优必选：2028年工业人形机器人产能目标10万台' });
  const ub2 = makeItem({ id: 'u2', source_id: 's2', source_name: 'S2', title: '优必选：目标2028年实现十万台工业人形机器人产能' });
  const nextStory = makeItem({ id: 'n1', source_id: 's4', source_name: 'S4', title: 'Fireworks AI寻求5亿美元新融资，估值或达60亿美元' });

  const page1 = clusterItemsWithMap([tpu1, tpu2, tpu3, ub1, ub2, nextStory], undefined, 2);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].related_items?.length, 2, 'All 3 Google TPU items merge into 1 cluster');
  assert.equal(page1.items[1].related_items?.length, 1, '10万台 and 十万台 UBTECH items merge');
  assert.equal(page1.consumedCount, 5, 'Consumed exact 5 raw items before the 3rd cluster');
  assert.equal(page1.hasMoreClusters, true);
});
