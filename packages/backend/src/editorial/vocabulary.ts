// Tag normalization over the industry pack's vocabulary (industry/taxonomy.ts), which the topics
// (industry/topics.json) are built on. Every domain (industry/domains.ts) has its own vocabulary.
import { DEFAULT_DOMAIN, DOMAINS, type DomainKey } from "@aihot/industry/domains";
import { CATEGORIES, ENTITIES, VOCABULARY } from "@aihot/industry/taxonomy";

export { CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, ITEM_TYPES_BY_DOMAIN, TOPIC_TAGS, VOCABULARY } from "@aihot/industry/taxonomy";

const allowed = Object.fromEntries(Object.entries(VOCABULARY).map(([d, v]) => [d, new Set<string>([...v.categoryTags, ...v.topicTags, ...v.entityTags])]));

/**
 * Known tags only, synonyms mapped, duplicates dropped, at most `max`; the category tag goes first. A list
 * without one gets `fallbackCategory` (deterministic, no repair call). The vocabulary is the domain's.
 */
export function normalizeTags(v: unknown, opts: { max?: number; fallbackCategory?: string; domain?: DomainKey } = {}): string[] {
  const max = opts.max ?? 6;
  const vocab = VOCABULARY[opts.domain ?? DEFAULT_DOMAIN];
  const known = allowed[opts.domain ?? DEFAULT_DOMAIN]!;
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，]/g) : [];
  const tags: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().replace(/^#/, "");
    const tag = vocab.synonyms[t] ?? vocab.synonyms[t.toLowerCase()] ?? t;
    if (tag && known.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  const isCategory = (t: string) => vocab.categoryTags.includes(t);
  const categoryIndex = tags.findIndex(isCategory);
  const fallback = opts.fallbackCategory && isCategory(opts.fallbackCategory) ? opts.fallbackCategory : vocab.categoryTags[vocab.categoryTags.length - 1]!;
  const category = categoryIndex >= 0 ? tags[categoryIndex]! : fallback;
  return [category, ...tags.filter((t) => t !== category)].slice(0, max);
}

/** The categories of one domain. */
export const domainCategories = (domain: DomainKey) => CATEGORIES.filter((c) => c.domain === domain);

/** The category guide the structure step reads: one line per category of the domain. */
export function categoryGuide(domain: DomainKey): string {
  return domainCategories(domain).map((c) => `- ${c.key}（${c.label}）：${c.guide}`).join("\n");
}
/** The finance guide (the vocabulary before domains). */
export const CATEGORY_GUIDE = categoryGuide(DEFAULT_DOMAIN);

/** The domain list the ordinary summary and the prefilter read. */
export const DOMAIN_GUIDE = DOMAINS.map((d) => `- ${d.key}（${d.label}）：${d.guide}`).join("\n");

/** Every domain's categories, for the ordinary summary (it picks the primary domain's). */
export const DOMAIN_CATEGORY_GUIDE = DOMAINS.map((d) =>
  `- ${d.key}（${d.label}）：${domainCategories(d.key).map((c) => `${c.key} ${c.label}`).join("；")}`).join("\n");

/** The subject entities of one domain, as the structure step lists them. */
export function entityGuide(domain: DomainKey): string {
  return Object.entries(ENTITIES).filter(([, e]) => e.domain === domain).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，");
}
