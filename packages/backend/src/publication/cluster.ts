// Event-level deduplication and multi-source aggregation ("同题多源") shared by
// the PostgreSQL publication snapshot and the Cloudflare D1 read layer.

export interface RelatedItemBrief {
  id: string;
  url: string;
  source_id: string;
  source_name: string;
  title: string;
  original_title?: string;
  title_en?: string | null;
  summary: string;
  summary_en?: string | null;
  category: string;
  selected: number;
  published_at: string | null;
  discovered_at: string;
  material_scope: string;
}

export interface ClusterableItem {
  id: string;
  url: string;
  source_id: string;
  source_name: string;
  title: string;
  original_title?: string;
  title_en?: string | null;
  summary: string;
  summary_en?: string | null;
  category: string;
  selected: number;
  published_at: string | Date | null;
  discovered_at: string | Date;
  material_scope: string;
  related_items?: RelatedItemBrief[];
}

const MEDIA_PREFIX_RE =
  /^(?:科创板日报|财联社|证券时报|上海证券报|中国证券报|第一财经|界面新闻|新京报|澎湃新闻|36氪|量子位|机器之心|极客公园|雷峰网|华尔街见闻早餐|华尔街见闻|21世纪经济报道|东方财富|外媒|韩媒|美媒|日媒|快讯|早报|晚报)[｜|：:\s]+/i;

const CANONICAL_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnvidia\b|\bnvda\b/gi, '英伟达'],
  [/\bjensen\s+huang\b|\bceo\s+huang\b/gi, '黄仁勋'],
  [/\bopenai\b|\bchatgpt\b/gi, 'openai'],
  [/\banthropic\b|\bclaude\b/gi, 'anthropic'],
  [/\bdeepseek\b|深度求索/gi, 'deepseek'],
  [/\bspacex\b/gi, 'spacex'],
  [/\bgoogle\b/gi, '谷歌'],
  [/\btesla\b/gi, '特斯拉'],
  [/\btsmc\b/gi, '台积电'],
  [/\basml\b/gi, '阿斯麦'],
  [/十万/g, '10万'],
  [/百万/g, '100万'],
  [/千万/g, '1000万'],
  [/两款|二款/g, '2款'],
  [/三款/g, '3款'],
  [/婚外情|婚外关系|私情|不忠行为|对妻子不忠|不忠|有染|past\s+affair|infidelity|decades-old\s+affair/gi, '婚外私情'],
  [/独立调查|展开调查|启动调查|将调查|聘律所调查|调查黄仁勋|board\s+probes|board\s+investigates|launches\s+inquiry|probes\s+ceo|probes\s+spying/gi, '启动调查'],
  [/道歉信|公开信道歉|发信致歉|向员工致歉|致员工信|发公开信|个人行为道歉|向妻子和员工道歉|致信员工|承认婚外情并致歉|message\s+to\s+our\s+company|apologizes\s+to/gi, '公开信致歉'],
  [/中国间谍|涉华间谍|间谍嫌疑|间谍疑云|间谍指控|涉嫌中国间谍|疑似中国间谍|suspected\s+chinese\s+spy|spying\s+allegations/gi, '间谍疑云'],
  [/美伊谈判|对伊战争|重启对伊|再次打击/gi, '美伊冲突谈判'],
  [/极不可能|可能性极低/gi, '极不可能'],
  [/加密货币|加密矿场/g, '加密货币'],
];

const STOP_BIGRAMS = new Set([
  '公司', '表示', '宣布', '发布', '披露', '公告', '报道', '消息', '研报', '市场',
  '投资', '科技', '人工', '工智', '智能', '20', '02', '26', '11', '1月', '月9', '9日',
  '月1', '10', '0日', '今日', '最新', '称若', '称英', '有限', '股份', '集团', '相关',
  '启动', '展开', '调查', '董事会', '董事', '事会', '人形', '形机', '机器', '器人',
  '数据', '据中', '中心', '大模', '模型', '算力', '概念', '念股', '芯片', '半导', '导体',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'over', 'after', 'from', 'into', 'that', 'this', 'says', 'amid', '2026', 'ai', 'ceo',
]);

const ENTITY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['nvidia', /英伟达|黄仁勋/],
  ['openai', /\bopenai\b|\bgpt-\d/],
  ['anthropic', /\banthropic\b/],
  ['deepseek', /\bdeepseek\b/],
  ['spacex', /\bspacex\b|星舰|星链|\bstarlink\b/],
  ['xai', /\bxai\b|\bgrok\b|孟菲斯/],
  ['google', /谷歌|\btpu\b/],
  ['alibaba', /阿里|千问|\bqwen\b|\btoken\s*plan\b/],
  ['bytedance', /字节跳动|豆包|\bseedream\b/],
  ['apple', /苹果|\bhalo\b/],
  ['fireworks', /\bfireworks\b/],
  ['workbuddy', /\bworkbuddy\b/],
  ['megaspeed', /\bmegaspeed\b/],
  ['ubtech', /优必选|\bubtech\b/],
  ['norway_grid', /挪威.*(?:数据中心|加密|算力)|(?:数据中心|加密|算力).*挪威/],
  ['us_close', /美股三大指数.*(?:收涨|涨逾|集体收涨)/],
  ['enflame', /燧原/],
  ['swancor', /上纬新材|启元/],
  ['tencent', /腾讯/],
  ['qualcomm', /高通/],
  ['karpathy', /\bkarpathy\b|\bhackertube\b/],
  ['nextdc', /\bnextdc\b|\bdigital\s*realty\b|\bgoodman\b/],
  ['trump_iran', /特朗普.*(?:美伊|对伊|伊朗)|美伊冲突谈判/],
  ['huaxin', /华新建材|\bcsn\b/],
  ['fengfan', /风范股份|唐控/],
  ['hengshun', /恒顺醋业/],
  ['cnnp', /中国核电/],
  ['mofcom', /商务部/],
  ['orbbec', /奥比中光/],
  ['unitree', /宇树/],
  ['agibot', /智元机器人/],
  ['cambricon', /寒武纪/],
  ['smic', /中芯国际|\bsmic\b/],
];

const FACET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['affair', /婚外私情/],
  ['probe', /启动调查/],
  ['apology', /公开信致歉/],
  ['spy', /间谍疑云/],
  ['board', /董事会/],
  ['natsec', /国家安全|机密信息/],
  ['heist', /被盗|1140万/],
  ['hk_chips', /60万枚|在港待运/],
  ['kr_auto', /韩国自动驾驶|智驾研发/],
  ['iran_strike', /美伊冲突谈判/],
  ['unlikely', /极不可能/],
  ['surge_17', /17%|四小龙|逼近涨停|午后.*(?:走强|拉升)|(?:走强|拉升).*午后/],
  ['cs146s', /\bcs146s\b/],
  ['tpu_launch', /(?:2款|两款|新款).*(?:tpu|ai芯片)|(?:tpu|ai芯片).*挑战.*英伟达/],
  ['us_close', /美股三大指数/],
];

const SUB_EVENT_ANGLE_RE =
  /elevenlabs|峰会|cramer|克莱默|gerber|格伯|75%|接班|继任|危机公关|公关战|盘前.*跌|跌超\d+%/i;

export function stripMediaPrefix(raw = ''): string {
  return String(raw || '').trim().replace(MEDIA_PREFIX_RE, '').trim();
}

export function normalizeClusterText(raw = ''): string {
  let s = stripMediaPrefix(raw);
  for (const [re, rep] of CANONICAL_REPLACEMENTS) {
    s = s.replace(re, ` ${rep} `);
  }
  return s.toLowerCase();
}

function extractBigrams(text: string): Set<string> {
  const norm = normalizeClusterText(text);
  const out = new Set<string>();
  for (const seg of norm.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (seg.length === 1) continue;
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.add(bg);
    }
  }
  for (const word of norm.match(/[a-z0-9]+(?:\.[0-9]+)?%?/g) ?? []) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) out.add(word);
  }
  return out;
}

function extractUnits(title: string): Map<string, Set<string>> {
  const norm = normalizeClusterText(title);
  const map = new Map<string, Set<string>>();
  const re = /(\d+(?:\.\d+)?)\s*(家|亿元|万元|万美元|亿美元|万头|万台|吉瓦|%|板|款)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const val = m[1], unit = m[2];
    const set = map.get(unit) ?? new Set<string>();
    set.add(val);
    map.set(unit, set);
  }
  return map;
}

function hasConflictingUnits(aTitle: string, bTitle: string): boolean {
  const ua = extractUnits(aTitle);
  const ub = extractUnits(bTitle);
  for (const [unit, valsA] of ua.entries()) {
    const valsB = ub.get(unit);
    if (!valsB) continue;
    let overlap = false;
    for (const v of valsA) {
      if (valsB.has(v)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) return true;
  }
  return false;
}

interface ItemFeatures<T extends ClusterableItem> {
  item: T;
  cleanTitle: string;
  cleanOrigTitle: string;
  normTitle: string;
  titleBigrams: Set<string>;
  leadBigrams: Set<string>;
  entities: Set<string>;
  titleFacets: Set<string>;
  leadFacets: Set<string>;
  ts: number;
}

function toIso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function buildFeatures<T extends ClusterableItem>(item: T): ItemFeatures<T> {
  const cleanTitle = stripMediaPrefix(item.title || '');
  const cleanOrigTitle = stripMediaPrefix(item.original_title || '');
  const leadRaw = `${cleanTitle} ${cleanOrigTitle} ${String(item.summary || '').slice(0, 150)}`;
  const normTitle = normalizeClusterText(cleanTitle);
  const normLead = normalizeClusterText(leadRaw);
  const titleBigrams = extractBigrams(cleanTitle);
  const leadBigrams = extractBigrams(leadRaw);
  const entities = new Set<string>();
  for (const [key, re] of ENTITY_PATTERNS) {
    if (re.test(normLead)) entities.add(key);
  }
  for (const m of cleanTitle.match(/[\u3400-\u9fff]{2,4}(?:股份|科技|集团|新材|证券|银行|药业|食品|物流|海洋|建材|空港|高速|生物|医疗|智能|半导体)/g) ?? []) {
    entities.add(m);
  }
  const titleFacets = new Set<string>();
  const leadFacets = new Set<string>();
  for (const [key, re] of FACET_PATTERNS) {
    if (re.test(normTitle)) titleFacets.add(key);
    if (re.test(normLead)) leadFacets.add(key);
  }
  const when = toIso(item.published_at) ?? toIso(item.discovered_at) ?? '';
  const ts = Date.parse(when);
  return { item, cleanTitle, cleanOrigTitle, normTitle, titleBigrams, leadBigrams, entities, titleFacets, leadFacets, ts };
}

function intersectCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  return (2 * intersectCount(a, b)) / (a.size + b.size);
}

function sameFeatures<T extends ClusterableItem>(fa: ItemFeatures<T>, fb: ItemFeatures<T>): boolean {
  if (fa.item.id === fb.item.id) return true;
  if (hasConflictingUnits(fa.cleanTitle, fb.cleanTitle)) return false;
  const gapMs = Number.isFinite(fa.ts) && Number.isFinite(fb.ts) ? Math.abs(fa.ts - fb.ts) : 0;
  if (gapMs > 72 * 3600 * 1000) return false;
  if (fa.cleanTitle.length >= 8 && fa.cleanTitle === fb.cleanTitle) return true;
  if (fa.cleanOrigTitle.length >= 8 && fa.cleanOrigTitle === fb.cleanOrigTitle) return true;
  if (fa.titleBigrams.size < 4 || fb.titleBigrams.size < 4) return false;

  const tOverlap = intersectCount(fa.titleBigrams, fb.titleBigrams);
  const tDice = dice(fa.titleBigrams, fb.titleBigrams);
  const lDice = dice(fa.leadBigrams, fb.leadBigrams);
  const sharedEnt = intersectCount(fa.entities, fb.entities);
  const sharedTF = intersectCount(fa.titleFacets, fb.titleFacets);
  const sharedLF = intersectCount(fa.leadFacets, fb.leadFacets);

  // Prevent merging different-day follow-ups on the same model/company across >36h unless facets strongly match.
  if (gapMs > 36 * 3600 * 1000 && sharedTF < 2 && tDice < 0.55) return false;

  // Prevent merging distinct sub-event follow-ups (e.g. conference cancellation, analyst commentary) into the main event.
  const angleA = SUB_EVENT_ANGLE_RE.exec(fa.normTitle)?.[0]?.toLowerCase() ?? '';
  const angleB = SUB_EVENT_ANGLE_RE.exec(fb.normTitle)?.[0]?.toLowerCase() ?? '';
  if ((angleA || angleB) && angleA !== angleB && tDice < 0.50) return false;

  // Within the same feed, merge near-identical reposts or same-entity same-topic updates.
  if (fa.item.source_id === fb.item.source_id) {
    if (tOverlap >= 6 && tDice >= 0.70) return true;
    if (sharedEnt >= 1 && tOverlap >= 4 && tDice >= 0.36) return true;
    if (sharedEnt >= 1 && sharedTF >= 1 && tOverlap >= 4 && tDice >= 0.28) return true;
    if (sharedTF >= 1 && tOverlap >= 4 && tDice >= 0.32) return true;
    return false;
  }

  if (sharedEnt === 0 && sharedTF === 0) {
    return tDice >= 0.42 && tOverlap >= 5;
  }
  if (tDice >= 0.36 && tOverlap >= 4) return true;
  if (sharedEnt >= 1 && tDice >= 0.24 && (tOverlap >= 4 || lDice >= 0.26)) return true;
  if (sharedEnt >= 1 && sharedLF >= 2 && sharedTF >= 1) return true;
  if (sharedEnt >= 1 && sharedTF >= 1 && (tOverlap >= 2 || lDice >= 0.20)) return true;
  return false;
}

export function sameStory(a: ClusterableItem, b: ClusterableItem): boolean {
  return sameFeatures(buildFeatures(a), buildFeatures(b));
}

function representativeScore<T extends ClusterableItem>(f: ItemFeatures<T>, preferredIds?: Set<string>): number {
  const item = f.item;
  let score = 0;
  if (preferredIds?.has(item.id)) score += 2000;
  if (item.selected) score += 1000;
  const sumLen = String(item.summary || '').trim().length;
  if (sumLen > 0) score += 500 + Math.min(120, Math.floor(sumLen / 3));
  if (/[\u3400-\u9fff]/.test(item.title || '')) score += 200;
  if (/新闻稿|官方|Blog|Release/i.test(item.source_name || '')) score += 90;
  // Slightly penalize multi-entity roundup headlines when focused single-event headlines exist.
  if (f.entities.size > 1) score -= 50 * (f.entities.size - 1);
  return score;
}

function toBrief(item: ClusterableItem): RelatedItemBrief {
  return {
    id: item.id,
    url: item.url,
    source_id: item.source_id,
    source_name: item.source_name,
    title: item.title,
    ...(item.original_title ? { original_title: item.original_title } : {}),
    ...(item.title_en != null ? { title_en: item.title_en } : {}),
    summary: item.summary || '',
    ...(item.summary_en != null ? { summary_en: item.summary_en } : {}),
    category: item.category || '',
    selected: Number(item.selected) ? 1 : 0,
    published_at: toIso(item.published_at),
    discovered_at: toIso(item.discovered_at) ?? new Date(0).toISOString(),
    material_scope: item.material_scope || '',
  };
}

/**
 * Group same-event items into clusters, returning one representative per cluster in original
 * discovery/report order, with the remaining outlets attached under `related_items`.
 */
export function clusterItemsWithMap<T extends ClusterableItem>(
  items: T[],
  preferredIds?: Set<string>,
  maxClusters?: number
): {
  items: Array<T & { related_items?: RelatedItemBrief[] }>;
  representativeById: Map<string, string>;
  consumedCount: number;
  hasMoreClusters: boolean;
} {
  const seenIds = new Set<string>();
  const groups: ItemFeatures<T>[][] = [];
  let consumedCount = 0;
  let hasMoreClusters = false;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!item?.id || seenIds.has(item.id)) {
      consumedCount = idx + 1;
      continue;
    }
    const f = buildFeatures(item);
    // Match against the group's primary anchor, the second member of a 2-item group, or at least 2 members.
    const group = groups.find(
      g =>
        sameFeatures(g[0], f) ||
        (g.length === 2 && sameFeatures(g[1], f)) ||
        (g.length >= 2 && g.filter(m => sameFeatures(m, f)).length >= 2)
    );
    if (group) {
      seenIds.add(item.id);
      group.push(f);
      // If the initial anchor was a multi-entity roundup and the new member is single-entity, promote it.
      if (group[0].entities.size > 1 && f.entities.size === 1) {
        const last = group.pop()!;
        group.unshift(last);
      }
      consumedCount = idx + 1;
    } else {
      if (maxClusters !== undefined && groups.length >= maxClusters) {
        hasMoreClusters = true;
        break;
      }
      seenIds.add(item.id);
      groups.push([f]);
      consumedCount = idx + 1;
    }
  }

  const representativeById = new Map<string, string>();
  const out: Array<T & { related_items?: RelatedItemBrief[] }> = [];

  for (const group of groups) {
    const sorted = [...group].sort((a, b) => representativeScore(b, preferredIds) - representativeScore(a, preferredIds));
    const rep = sorted[0].item;
    for (const m of group) representativeById.set(m.item.id, rep.id);

    // Attach distinct related coverage (preferring one entry per source_name first, up to 8).
    const related: RelatedItemBrief[] = [];
    const seenSources = new Set<string>([rep.source_name]);
    const repHasZhSummary = Boolean(rep.summary && rep.summary.trim()) && /[\u3400-\u9fff]/.test(rep.title || '');
    const rest = sorted.slice(1).map(x => x.item);
    for (const other of rest) {
      if (seenSources.has(other.source_name)) continue;
      if (repHasZhSummary && !other.summary?.trim() && !/[\u3400-\u9fff]/.test(other.title || '')) continue;
      seenSources.add(other.source_name);
      related.push(toBrief(other));
      if (related.length >= 8) break;
    }
    // Also merge any pre-existing related_items on members.
    for (const m of group) {
      for (const prev of m.item.related_items ?? []) {
        if (repHasZhSummary && !prev.summary?.trim() && !/[\u3400-\u9fff]/.test(prev.title || '')) continue;
        if (prev.id !== rep.id && !related.some(r => r.id === prev.id) && !seenSources.has(prev.source_name) && related.length < 8) {
          seenSources.add(prev.source_name);
          related.push(prev);
        }
      }
    }

    out.push(related.length ? { ...rep, related_items: related } : rep);
  }

  return { items: out, representativeById, consumedCount, hasMoreClusters };
}

export function clusterItems<T extends ClusterableItem>(items: T[], preferredIds?: Set<string>): Array<T & { related_items?: RelatedItemBrief[] }> {
  return clusterItemsWithMap(items, preferredIds).items;
}

/**
 * Deduplicate a daily report's items and backfill freed-up slots from the report's 24h candidate pool
 * using round-robin source diversity so a 20-item brief stays at 20 distinct stories.
 */
export function clusterReportItems<T extends ClusterableItem>(
  reportItems: T[],
  windowCandidates: T[] = [],
  targetCount = 20,
  preferredIds?: Set<string>
): { items: Array<T & { related_items?: RelatedItemBrief[] }>; representativeById: Map<string, string> } {
  const reportIdSet = new Set(reportItems.map(i => i.id));
  const combined = [...reportItems, ...windowCandidates.filter(c => !reportIdSet.has(c.id))];
  const { items: allClusters, representativeById } = clusterItemsWithMap(combined, preferredIds);

  // Clusters that contain at least one item from the original report come first, in report order.
  const primaryReportClusters: Array<T & { related_items?: RelatedItemBrief[] }> = [];
  const backfillPool: Array<T & { related_items?: RelatedItemBrief[] }> = [];
  for (const cluster of allClusters) {
    const inOriginal =
      reportIdSet.has(cluster.id) || (cluster.related_items?.some(r => reportIdSet.has(r.id)) ?? false);
    if (inOriginal) primaryReportClusters.push(cluster);
    else backfillPool.push(cluster);
  }

  if (primaryReportClusters.length >= targetCount || backfillPool.length === 0) {
    return { items: primaryReportClusters.slice(0, Math.max(targetCount, primaryReportClusters.length)), representativeById };
  }

  const needed = targetCount - primaryReportClusters.length;
  const roundRobin = (pool: Array<T & { related_items?: RelatedItemBrief[] }>, cap: number) => {
    const bySource = new Map<string, Array<T & { related_items?: RelatedItemBrief[] }>>();
    for (const item of pool) {
      const list = bySource.get(item.source_id) ?? [];
      list.push(item);
      bySource.set(item.source_id, list);
    }
    const picked: Array<T & { related_items?: RelatedItemBrief[] }> = [];
    while (picked.length < cap) {
      let added = false;
      for (const list of bySource.values()) {
        if (list.length && picked.length < cap) {
          picked.push(list.shift()!);
          added = true;
        }
      }
      if (!added) break;
    }
    return picked;
  };

  const withSummary = backfillPool.filter(i => i.summary && String(i.summary).trim());
  const withoutSummary = backfillPool.filter(i => !i.summary || !String(i.summary).trim());
  const firstFill = roundRobin(withSummary, needed);
  const filled =
    firstFill.length >= needed
      ? firstFill
      : [...firstFill, ...roundRobin(withoutSummary, needed - firstFill.length)];

  return { items: [...primaryReportClusters, ...filled], representativeById };
}
