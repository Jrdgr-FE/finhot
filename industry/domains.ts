// 领域：本站覆盖的几个领域（AI 与硬科技、金融）。每个领域有自己的分类、评分标准、门槛、术语规则和日报。
// 一条资料可以同时属于几个领域（例如“英伟达财报”既是 AI 与硬科技，也是金融）；第一个领域是它的主领域，
// 决定用哪个领域的评分标准、门槛、分类和术语规则。
// key 会出现在网址里（/all?domain=ai）和日报类型里（ai-daily），上线后不要改。
import pack from './sources.json' with { type: 'json' };
import { SELECTION } from './selection.ts';

export interface DomainDef {
  key: string;
  /** 页面上的名称。 */
  label: string;
  /** 英文名称。 */
  labelEn: string;
  /** 普通摘要判断领域时看的说明。 */
  guide: string;
  /** 提示词文件（industry/prompts/<name>.md）。 */
  prompts: { score: string; understand: string };
  /** 拿不准归哪一类时的分类。 */
  fallbackCategory: string;
}

export const DOMAINS = [
  {
    key: 'ai',
    label: 'AI 与硬科技',
    labelEn: 'AI & Deep Tech',
    guide: 'AI 模型、AI 产品与开发工具、论文研究、芯片与半导体、算力与数据中心、机器人与具身智能，以及这些公司和技术的融资并购、财报、人事、诉讼、政策与出口管制',
    prompts: { score: 'selection-score.ai', understand: 'understand.ai' },
    fallbackCategory: 'ai-business',
  },
  {
    key: 'finance',
    label: '金融',
    labelEn: 'Finance',
    guide: '市场行情与交易制度、上市公司披露（财报、业绩预告、并购重组、回购分红、重大订单、风险事件，不限于金融行业的公司）、有分析依据的公司、行业、策略与宏观研究、金融政策与监管、宏观与金融统计数据、银行证券保险资管机构的经营与人事',
    prompts: { score: 'selection-score', understand: 'understand' },
    fallbackCategory: 'institution',
  },
] as const satisfies readonly DomainDef[];

export type DomainKey = (typeof DOMAINS)[number]['key'];
export const DOMAIN_KEYS = DOMAINS.map((d) => d.key) as unknown as readonly [DomainKey, ...DomainKey[]];
/** 加领域之前的资料、没有标领域的信源都算这个领域。 */
export const DEFAULT_DOMAIN: DomainKey = 'finance';

export function isDomainKey(value: unknown): value is DomainKey {
  return typeof value === 'string' && (DOMAIN_KEYS as readonly string[]).includes(value);
}
export function domainDef(key: DomainKey): (typeof DOMAINS)[number] {
  return DOMAINS.find((d) => d.key === key)!;
}

/** 门槛：领域 × 信源分级（industry/selection.ts）。没有列出的分级不评精选。 */
export function domainThreshold(domain: DomainKey, tier: string): number | null {
  return SELECTION.byDomain[domain]?.[tier] ?? null;
}

const sourceDomainMap = new Map<string, DomainKey[]>(pack.sources.map((s) => {
  const listed = ((s as { domains?: unknown }).domains as unknown[] | undefined)?.filter(isDomainKey) ?? [];
  return [s.id, listed.length ? [...new Set(listed)] : [DEFAULT_DOMAIN]];
}));
/** 信源的主领域（sources.json 的 domains）；没写或后台新建的信源算默认领域。 */
export function sourceDomains(sourceId: string): DomainKey[] {
  return sourceDomainMap.get(sourceId) ?? [DEFAULT_DOMAIN];
}

/** 报告类型：金融沿用 daily/weekly/monthly，其他领域加前缀（ai-daily）。 */
export function reportKind<K extends 'daily' | 'weekly' | 'monthly'>(kind: K, domain: DomainKey): K | `${DomainKey}-${K}` {
  return domain === DEFAULT_DOMAIN ? kind : `${domain}-${kind}`;
}

/**
 * 只看标题的兜底：没有模型判断领域时（普通摘要额度用完、存量资料），按信源主领域，
 * 再给标题明确讲 AI 与硬科技的金融资料补上 ai，只用于导航，不触发精选。
 */
const AI_TITLE = /人工智能|大模型|生成式|智能体|ChatGPT|OpenAI|Anthropic|DeepSeek|英伟达|NVIDIA|半导体|芯片|晶圆|光刻|算力|智算|数据中心|HBM|GPU|人形机器人|具身智能|机器人/i;
export function basicDomains(sourceId: string, title: string): DomainKey[] {
  const listed = sourceDomains(sourceId);
  return !listed.includes('ai') && AI_TITLE.test(title) ? [...listed, 'ai'] : listed;
}
