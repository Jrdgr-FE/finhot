// Daily, weekly and monthly reports. Windows are Beijing calendar based and written into the report;
// missed schedule points are caught up; regeneration creates a revision. The editors' prompts are in
// the industry pack (industry/prompts/report-*.md), the sections follow its categories. Every domain
// (industry/domains.ts) has its own daily report (finance: kind daily; ai: ai-daily): the selected items
// that belong to it, and a written review of the window's important stories (reviewMaterial: selected,
// high-scoring or widely reported); a cross-domain item can be in both.
import { z } from "zod";
import { SITE } from "@aihot/industry/site";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { DEFAULT_DOMAIN, domainDef, isDomainKey, reportKind, type DomainKey } from "@aihot/industry/domains";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { modelFor } from "../editorial/models.ts";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt, BudgetExceededError } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { WITHHELD_SOURCE_IDS } from "../publication/edge.ts";

export const REPORT_VERSION = promptVersion("report-daily-review", "report-period");

const SECTION_OF: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.section]));
/** A domain's sections in report order, and where its items without a (domain) category go. */
function sectionsOf(domain: DomainKey) {
  const own = CATEGORIES.filter((c) => c.domain === domain);
  const order = [...new Set(own.map((c) => c.section))];
  const of = Object.fromEntries(own.map((c) => [c.key, c.section])) as Record<string, string>;
  return { order, of, fallback: of[domainDef(domain).fallbackCategory] ?? order.at(-1)! };
}

/** Weekly and monthly reports are finance's; their items' sections (any domain's category) and fallback. */
const DEFAULT_SECTION = sectionsOf(DEFAULT_DOMAIN).fallback;

/**
 * The domains whose daily report is composed: finance always, others when listed in
 * FINHOT_REPORT_DOMAINS (comma separated, e.g. "ai"), so a domain is switched on once its sources are live.
 */
export function reportDomains(env: string | undefined = process.env.FINHOT_REPORT_DOMAINS): DomainKey[] {
  const listed = (env ?? "").split(",").map((d) => d.trim()).filter(isDomainKey);
  return [...new Set<DomainKey>([DEFAULT_DOMAIN, ...listed])];
}

export interface ReportEntry {
  itemId: string;
  factId: string | null;
  storyPublicId: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  firstParty: boolean;
  role: string;
  score: number | null;
  publishedAt: string;
}

export interface Candidate extends ReportEntry {
  category: string | null;
  factKey: string;
}

function roleOf(kind: string, firstParty: boolean): string {
  if (firstParty) return kind === "x_search" ? "X·官方" : "官方";
  if (kind === "x_search") return "X·KOL";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

export async function candidates(start: Date, end: Date, domain?: DomainKey): Promise<Candidate[]> {
  const rows = await sql.begin("isolation level read committed", async (tx) => {
    // Wait for in-flight releases and keep later ones outside this snapshot. The following SELECT
    // gets a fresh READ COMMITTED snapshot; model calls and report writes happen after the lock ends.
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    return tx<{
      id: string; title: string; summary: string | null; url: string; category: string | null; score: number | null; first_party: boolean;
      source_id: string; source_name: string; source_kind: string; fact_public_id: string | null; story_public_id: string | null; at: Date; backfill: boolean;
    }[]>`
      SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.score, p.first_party, s.id AS source_id, s.name AS source_name,
             s.kind AS source_kind, f.public_id AS fact_public_id, st.public_id::text AS story_public_id, p.timeline_at AS at, p.backfill
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN facts f ON f.id = p.fact_id LEFT JOIN stories st ON st.id = f.story_id
      -- Attribute each item by the later of arrival and release; either range can use its index.
      WHERE p.visibility = 'public' AND p.selected AND NOT p.backfill AND NOT s.id = ANY(${WITHHELD_SOURCE_IDS}::text[])
        ${domain ? tx`AND p.domains @> ARRAY[${domain}]::text[]` : tx``}
        AND (
          (p.visible_after <= p.timeline_at AND p.timeline_at >= ${start} AND p.timeline_at < ${end})
          OR (p.visible_after > p.timeline_at AND p.visible_after >= ${start} AND p.visible_after < ${end})
        )`;
  });
  // One entry per fact: first-party first, then score.
  const byFact = new Map<string, Candidate>();
  for (const r of rows) {
    const key = r.fact_public_id ?? `a:${r.id}`;
    const c: Candidate = {
      itemId: r.id, factId: r.fact_public_id, storyPublicId: r.story_public_id, title: r.title, summary: r.summary ?? "",
      sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party, role: roleOf(r.source_kind, r.first_party),
      score: r.score === null ? null : Number(r.score), publishedAt: r.at.toISOString(), category: r.category, factKey: key,
    };
    const prev = byFact.get(key);
    if (!prev || Number(c.firstParty) - Number(prev.firstParty) > 0 || (c.firstParty === prev.firstParty && (c.score ?? 0) > (prev.score ?? 0))) byFact.set(key, c);
  }
  return [...byFact.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** An item of the daily review's material: whether it was selected, and how many sources reported its story. */
export interface ReviewEntry extends ReportEntry { selected: boolean; sources: number }
interface Material extends Candidate { selected: boolean; sources: number }

/** Importance for the review: a selected item, then its score (unscored counts as 45), then breadth and first party. */
const weightOf = (m: Material) => (m.selected ? 30 : 0) + (m.score ?? 45) + Math.min(m.sources, 6) * 6 + (m.firstParty ? 5 : 0);

/**
 * The daily review's material: the window's items with a summary that were selected, scored 60 or more, or
 * belong to a story three or more sources reported in the window; one entry per story (else fact), the most
 * important first. Items are attributed to the window as the report's candidates are.
 */
export async function reviewMaterial(start: Date, end: Date, domain: DomainKey = DEFAULT_DOMAIN, limit = 40): Promise<Material[]> {
  const rows = await sql.begin("isolation level read committed", async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    return tx<{
      id: string; title: string; summary: string; url: string; category: string | null; score: number | null; selected: boolean; first_party: boolean;
      source_id: string; source_name: string; source_kind: string; fact_public_id: string | null; story_id: number | null; story_public_id: string | null; at: Date; sources: number;
    }[]>`
      WITH win AS (
        SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.score, p.selected, p.first_party, s.id AS source_id, s.name AS source_name,
               s.kind AS source_kind, f.public_id AS fact_public_id, f.story_id, st.public_id::text AS story_public_id,
               CASE WHEN p.selected AND p.visible_after > p.timeline_at THEN p.visible_after ELSE p.timeline_at END AS at
        FROM publications p JOIN sources s ON s.id = p.source_id
        LEFT JOIN facts f ON f.id = p.fact_id LEFT JOIN stories st ON st.id = f.story_id
        WHERE p.visibility = 'public' AND NOT p.backfill AND coalesce(p.summary, '') <> '' AND NOT s.id = ANY(${WITHHELD_SOURCE_IDS}::text[])
          AND (p.domains @> ARRAY[${domain}]::text[] OR (${domain} = ${DEFAULT_DOMAIN} AND coalesce(cardinality(p.domains), 0) = 0))
          AND (
            ((NOT p.selected OR p.visible_after <= p.timeline_at) AND p.timeline_at >= ${start} AND p.timeline_at < ${end})
            OR (p.selected AND p.visible_after > p.timeline_at AND p.visible_after >= ${start} AND p.visible_after < ${end})
          )
      ), breadth AS (SELECT story_id, count(DISTINCT source_id)::int AS sources FROM win WHERE story_id IS NOT NULL GROUP BY story_id)
      SELECT w.*, coalesce(b.sources, 1) AS sources FROM win w LEFT JOIN breadth b ON b.story_id = w.story_id
      WHERE w.selected OR w.score >= 60 OR coalesce(b.sources, 1) >= 3`;
  });
  const byStory = new Map<string, Material>();
  for (const r of rows) {
    const m: Material = {
      itemId: r.id, factId: r.fact_public_id, storyPublicId: r.story_public_id, title: r.title, summary: r.summary,
      sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party, role: roleOf(r.source_kind, r.first_party),
      score: r.score === null ? null : Number(r.score), publishedAt: r.at.toISOString(), category: r.category,
      factKey: r.fact_public_id ?? `a:${r.id}`, selected: r.selected, sources: Number(r.sources),
    };
    const key = r.story_id !== null ? `s:${r.story_id}` : m.factKey, prev = byStory.get(key);
    if (!prev || Number(m.firstParty) - Number(prev.firstParty) > 0 || (m.firstParty === prev.firstParty && weightOf(m) > weightOf(prev))) byStory.set(key, m);
  }
  return [...byStory.values()].sort((a, b) => weightOf(b) - weightOf(a)).slice(0, limit);
}

/** Facts and items already covered by recent editions (their lists and reviews) are not repeated. */
async function recentlyCovered(kind: string, before: string, days = 7): Promise<Set<string>> {
  const rows = await sql<{ content: Record<string, any> }[]>`
    SELECT content FROM reports WHERE kind = ${kind} AND key < ${before} AND key >= ${addDays(before, -days)}`;
  const out = new Set<string>();
  for (const r of rows) {
    for (const s of r.content.sections ?? []) for (const it of s.items ?? []) {
      if (it.itemId) out.add(`a:${it.itemId}`);
      if (it.factId) out.add(it.factId);
      if (it.clusterId) out.add(`c:${it.clusterId}`);
    }
    for (const t of r.content.review?.themes ?? []) for (const it of t.refs ?? []) {
      if (it.itemId) out.add(`a:${it.itemId}`);
      if (it.factId) out.add(it.factId);
    }
  }
  return out;
}

/** The daily review: the window's material as a numbered list for the editor; refs point back into it. */
async function writeReview(kind: string, key: string, start: Date, end: Date, material: Material[], model: string, domain: DomainKey) {
  const { of: sectionOf, fallback } = sectionsOf(domain), at = (d: Date) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ");
  const list = material.map((e, i) => `${i + 1}. [${sectionOf[e.category ?? ""] ?? fallback}] ${e.title}｜${e.summary.slice(0, 160)}｜${e.sourceName}${e.sources > 1 ? `，${e.sources} 家来源` : ""}${e.selected ? "，精选" : ""}`).join("\n");
  const res = await chatJson({
    model, purpose: "report_review", subject: `report:${kind}:${key}`, promptVersion: REPORT_VERSION,
    system: promptText("report-daily-review", { domainName: domainDef(domain).label }),
    user: `窗口：${at(start)} 至 ${at(end)}（北京时间）\n${list}`, schema: PeriodSchema, temperature: 0.3, maxTokens: 2500,
  });
  const entry = ({ category: _c, factKey: _f, ...e }: Material): ReviewEntry => e;
  const themes = res.data.themes.map((t) => ({
    heading: t.heading, summary: t.summary,
    refs: [...new Set(t.refs.map(Number))].map((n) => material[n - 1]).filter((e): e is Material => !!e).map(entry),
  }));
  return { review: { headline: res.data.headline.trim(), overview: res.data.overview, themes }, receiptId: res.receiptId };
}

async function saveReport(kind: string, key: string, start: Date, end: Date, content: Record<string, unknown>, reason: string, model: string) {
  await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: number; revision: number; content: unknown; generated_at: Date }[]>`
      SELECT id, revision, content, generated_at FROM reports WHERE kind = ${kind} AND key = ${key} FOR UPDATE`;
    if (existing) {
      await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at, reason)
               VALUES (${existing.id}, ${existing.revision}, ${tx.json(existing.content as never)}, ${existing.generated_at}, ${reason}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE reports SET content = ${tx.json(content as never)}, window_start = ${start}, window_end = ${end}, generated_at = now(),
                 model = ${model}, revision = revision + 1, origin = 'model', updated_at = now() WHERE id = ${existing.id}`;
    } else {
      await tx`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
               VALUES (${kind}, ${key}, ${start}, ${end}, ${tx.json(content as never)}, now(), ${model}, 'model')`;
    }
  });
}

/**
 * The daily edition for Beijing date D, which covers [D-1 08:00, D 08:00) Beijing time; one per domain. It
 * is returned, not saved: composeDaily saves it, a preview can show it first. Selected items make the list;
 * the review is written from the wider material (one call). A review the budget or the model cannot give
 * leaves the edition with its list, as before.
 */
export async function draftDaily(date: string, domain: DomainKey = DEFAULT_DOMAIN) {
  const end = new Date(beijingMidnight(date).getTime() + 8 * 3600 * 1000);
  const start = new Date(end.getTime() - 86400000);
  const kind = reportKind("daily", domain), { order: SECTION_ORDER, of: SECTION_OF, fallback: DEFAULT_SECTION } = sectionsOf(domain);
  const covered = await recentlyCovered(kind, date);
  // Finance keeps reading every selected item (all of them were finance before domains).
  const all = await candidates(start, end, domain === DEFAULT_DOMAIN ? undefined : domain);
  const fresh = all.filter((c) => !covered.has(c.factKey) && !covered.has(`a:${c.itemId}`));
  const perSection = new Map<string, Candidate[]>();
  const flashes: Array<{ itemId: string; title: string; sourceName: string; sourceUrl: string; publishedAt: string }> = [];
  for (const c of fresh) {
    const label = SECTION_OF[c.category ?? ""] ?? DEFAULT_SECTION;
    const list = perSection.get(label) ?? [];
    if (list.length < 8) list.push(c);
    else if (flashes.length < 12) flashes.push({ itemId: c.itemId, title: c.title, sourceName: c.sourceName, sourceUrl: c.sourceUrl, publishedAt: c.publishedAt });
    perSection.set(label, list);
  }
  const sections = SECTION_ORDER.filter((l) => perSection.get(l)?.length).map((label) => ({
    label,
    items: perSection.get(label)!.map(({ category: _c, factKey: _f, ...entry }) => entry),
  }));
  const ordered = sections.flatMap((s) => s.items).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const material = (await reviewMaterial(start, end, domain)).filter((m) => !covered.has(m.factKey) && !covered.has(`a:${m.itemId}`));
  const model = await modelFor("report");
  let written: Awaited<ReturnType<typeof writeReview>> | null = null;
  let leadDeferred = false, reviewFailed = false;
  const leadEnabled = process.env.FINHOT_REPORT_LEAD_ENABLED !== 'false';
  if (material.length && leadEnabled) {
    try { written = await writeReview(kind, date, start, end, material, model, domain); }
    catch (error) {
      if (error instanceof BudgetExceededError) leadDeferred = true;
      else { reviewFailed = true; console.error(JSON.stringify({ level: "warn", msg: "daily review failed", kind, date, error: String(error).slice(0, 300) })); }
    }
  }
  const review = written?.review ?? null;
  const content = {
    date,
    review,
    // The server's report pages and feeds read the review's headline and overview as the lead.
    lead: review ? { title: review.headline, leadParagraph: review.overview.slice(0, 600) } : null,
    highlights: review ? [...new Set(review.themes.flatMap((t) => t.refs.map((e) => e.itemId)))].slice(0, 5) : [],
    sections,
    flashes,
    metrics: {
      totalEvents: ordered.length,
      sourcesCount: new Set(ordered.map((e) => e.sourceId)).size,
      modelsReleased: perSection.get("模型与产品")?.length ?? 0,
      firstPartyEvents: ordered.filter((e) => e.firstParty).length,
      reviewMaterial: material.length,
    },
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    generator: { version: REPORT_VERSION, model, repeatsSuppressed: all.length - fresh.length, leadDeferred, leadEnabled, ...(reviewFailed ? { reviewFailed } : {}) },
  };
  return { kind, start, end, model, content, receiptId: written?.receiptId ?? null, entries: ordered.length };
}

export async function composeDaily(date: string, reason = "scheduled", domain: DomainKey = DEFAULT_DOMAIN): Promise<{ key: string; entries: number }> {
  const draft = await draftDaily(date, domain);
  await saveReport(draft.kind, date, draft.start, draft.end, draft.content, reason, draft.model);
  if (draft.receiptId) await completeReceipt(sql, draft.receiptId);
  return { key: date, entries: draft.entries };
}

export const PeriodSchema = z.object({
  // A headline is asked for, but a missing or unusable one leaves the issue on its generic name.
  headline: z.string().max(60).catch(""),
  overview: z.string().max(1500),
  themes: z
    // A theme cites at most eight entries; a model that lists more keeps its first eight rather than failing the issue.
    .array(z.object({ heading: z.string().max(60), summary: z.string().max(800), refs: z.array(z.union([z.number(), z.string()])).transform((refs) => refs.slice(0, 8)) }))
    .min(1)
    .transform((themes) => themes.slice(0, 6)),
});

/** The editor's brief for a week or month: its top entries as a numbered list, each with its section. */
export function periodPrompt(kind: "weekly" | "monthly", startDate: string, endDateInclusive: string, top: Candidate[]) {
  const list = top.map((e, i) => `${i + 1}. [${SECTION_OF[e.category ?? ""] ?? DEFAULT_SECTION}] ${e.title}｜${e.summary.slice(0, 140)}`).join("\n");
  return {
    system: promptText("report-period", { domainName: domainDef(DEFAULT_DOMAIN).label, kindName: kind === "weekly" ? "周报" : "月报", overviewLength: kind === "weekly" ? "150–300" : "200–400" }),
    user: `本期：${startDate} 至 ${endDateInclusive}\n${list}`,
  };
}

async function composePeriod(kind: "weekly" | "monthly", key: string, startDate: string, endDateInclusive: string, reason: string) {
  const start = beijingMidnight(startDate);
  const end = beijingMidnight(addDays(endDateInclusive, 1));
  const all = await candidates(start, end);
  const top = all.slice(0, kind === "weekly" ? 40 : 60);
  const dailyCount = (await sql<{ n: number }[]>`SELECT count(*) AS n FROM reports WHERE kind = 'daily' AND key >= ${startDate} AND key <= ${endDateInclusive}`)[0]?.n ?? 0;
  let themes: Array<{ heading: string; summary: string; storyRefs: ReportEntry[] }> = [];
  let headline = "";
  let overview = "";
  let receiptId: number | null = null;
  const model = await modelFor("report");
  if (top.length) {
    const res = await chatJson({
      model, purpose: `report_${kind}`, subject: `report:${kind}:${key}`, promptVersion: REPORT_VERSION,
      ...periodPrompt(kind, startDate, endDateInclusive, top), schema: PeriodSchema, temperature: 0.3, maxTokens: 2500,
    });
    receiptId = res.receiptId;
    headline = res.data.headline.trim();
    overview = res.data.overview;
    themes = res.data.themes.map((t) => ({
      heading: t.heading,
      summary: t.summary,
      storyRefs: t.refs.map((r) => top[Number(r) - 1]).filter((e): e is Candidate => !!e).map(({ category: _c, factKey: _f, ...e }) => e),
    }));
  }
  const content = {
    kind,
    title: kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`,
    ...(kind === "weekly" ? { isoLabel: key } : { monthLabel: key }),
    periodStart: startDate,
    periodEnd: endDateInclusive,
    ...(headline ? { headline } : {}),
    overview,
    themes,
    storyOrder: top.map((e) => e.itemId),
    metrics: { totalStories: themes.reduce((n, t) => n + t.storyRefs.length, 0), selectedCount: all.length, reportsCovered: Number(dailyCount) },
    generator: { version: REPORT_VERSION, model },
  };
  await saveReport(kind, key, start, end, content, reason, model);
  if (receiptId) await completeReceipt(sql, receiptId);
  return { key, entries: top.length };
}

export async function composeWeekly(label: string, reason = "scheduled") {
  const range = isoWeekRange(label);
  if (!range) throw new Error(`bad week label ${label}`);
  return composePeriod("weekly", label, range.start, range.end, reason);
}

export async function composeMonthly(label: string, reason = "scheduled") {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad month label ${label}`);
  const start = `${label}-01`;
  const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, "0")}-01`;
  return composePeriod("monthly", label, start, addDays(next, -1), reason);
}

/** Repair only empty editions with actual, already released candidates in their original window.
 * Newly reviewed items released after 08:00 still belong to the next edition.
 */
export async function repairEmptyDailyReports(now=new Date(),days=3):Promise<string[]>{
  const today=beijingDate(now),hour=Number(new Date(now.getTime()+8*3600000).toISOString().slice(11,13));
  const latestDue=hour>=8?today:addDays(today,-1);
  const repaired:string[]=[];
  for(const domain of reportDomains()){
    const kind=reportKind('daily',domain);
    const rows=await sql<{key:string;window_start:Date;window_end:Date}[]>`SELECT key,window_start,window_end FROM reports
      WHERE kind=${kind} AND key>=${addDays(latestDue,-days+1)} AND key<=${latestDue}
        AND jsonb_array_length(jsonb_path_query_array(content,'$.sections[*].items[*]'))=0
        AND jsonb_array_length(coalesce(content->'flashes','[]'::jsonb))=0 ORDER BY key`;
    for(const row of rows){
      if(shutdownSignal.signal.aborted)return repaired;
      const covered=await recentlyCovered(kind,row.key);
      const available=(await candidates(row.window_start,row.window_end,domain===DEFAULT_DOMAIN?undefined:domain)).filter(c=>!covered.has(c.factKey)&&!covered.has('a:'+c.itemId));
      if(!available.length)continue;
      await composeDaily(row.key,'repair-empty',domain);repaired.push(domain===DEFAULT_DOMAIN?row.key:`${domain}:${row.key}`);
    }
  }
  return repaired;
}

/**
 * Editions of the last days published without their review because the budget deferred it are written again
 * once a review can be had (one call each); a retry that still gets none leaves the edition as it is.
 */
export async function repairDeferredReviews(now = new Date(), days = 2): Promise<string[]> {
  if (process.env.FINHOT_REPORT_LEAD_ENABLED === 'false') return [];
  const today = beijingDate(now), hour = Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 13));
  const latestDue = hour >= 8 ? today : addDays(today, -1);
  const repaired: string[] = [];
  for (const domain of reportDomains()) {
    const kind = reportKind('daily', domain);
    const rows = await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind = ${kind} AND key >= ${addDays(latestDue, -days + 1)} AND key <= ${latestDue}
      AND coalesce(content->'review', 'null'::jsonb) = 'null'::jsonb AND coalesce((content->'generator'->>'leadDeferred')::boolean, false) ORDER BY key`;
    for (const row of rows) {
      if (shutdownSignal.signal.aborted) return repaired;
      const draft = await draftDaily(row.key, domain);
      if (!draft.content.review) continue;
      await saveReport(kind, row.key, draft.start, draft.end, draft.content, 'review-deferred', draft.model);
      if (draft.receiptId) await completeReceipt(sql, draft.receiptId);
      repaired.push(domain === DEFAULT_DOMAIN ? row.key : `${domain}:${row.key}`);
    }
  }
  return repaired;
}

/**
 * Catch-up: generates any missing daily report for the last `days` days (never the future and never
 * before the first report in the database), the last complete week and the last complete month.
 */
export async function catchUpReports(now = new Date(), days = 7): Promise<{ generated: string[] }> {
  const generated: string[] = [];
  const today = beijingDate(now);
  const bjHour = Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 13));
  const latestDue = bjHour >= 8 ? today : addDays(today, -1);
  for (const domain of reportDomains()) {
    const kind = reportKind("daily", domain);
    const [first] = await sql<{ key: string | null }[]>`SELECT min(key) AS key FROM reports WHERE kind = ${kind}`;
    // A newly switched-on domain starts with its scheduled edition, not a week of back issues.
    if (domain !== DEFAULT_DOMAIN && !first?.key) continue;
    for (let i = days - 1; i >= 0; i--) {
      if (shutdownSignal.signal.aborted) return { generated }; // the next hourly run continues
      const d = addDays(latestDue, -i);
      if (first?.key && d < first.key) continue;
      const [exists] = await sql`SELECT 1 FROM reports WHERE kind = ${kind} AND key = ${d}`;
      if (!exists) {
        await composeDaily(d, "catch-up", domain);
        generated.push(`${kind}:${d}`);
      }
    }
  }
  // Last complete ISO week (Monday 10:00 onwards).
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const lastWeek = isoWeekLabel(addDays(today, -dow - 7));
  const weekDue = dow > 0 || bjHour >= 10;
  if (weekDue) {
    const [w] = await sql`SELECT 1 FROM reports WHERE kind = 'weekly' AND key = ${lastWeek}`;
    if (!w) {
      await composeWeekly(lastWeek, "catch-up");
      generated.push(`weekly:${lastWeek}`);
    }
  }
  // Last complete month (1st 10:30 onwards).
  const [y, mo, dd] = today.split("-").map(Number) as [number, number, number];
  const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  const monthDue = dd > 1 || bjHour > 10 || (bjHour === 10 && Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(14, 16)) >= 30);
  if (monthDue) {
    const [m] = await sql`SELECT 1 FROM reports WHERE kind = 'monthly' AND key = ${prevMonth}`;
    if (!m) {
      await composeMonthly(prevMonth, "catch-up");
      generated.push(`monthly:${prevMonth}`);
    }
  }
  return { generated };
}
