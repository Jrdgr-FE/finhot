// The Cloudflare frontend's existing DTOs, read from the same PostgreSQL publication projection.
import pack from "../../../../industry/sources.json" with { type: "json" };
import { CATEGORIES } from "@aihot/industry/taxonomy";
import {basicCategory} from '@aihot/industry/classification';
import { DEFAULT_DOMAIN, DOMAINS, isDomainKey, reportKind, sourceDomains, type DomainKey } from "@aihot/industry/domains";
import { sql, type Db } from "../db.ts";
import { listedCondition, selectedCondition } from "./items.ts";
import { loadReport, reportIndexRows } from "./reports.ts";
import { feedRepresentatives, type FoldRow } from "../events/fold.ts";
import type {SyncItem} from './synced.ts';
type EdgeItem=Omit<SyncItem,'published_at'|'discovered_at'|'ready_at'> & {published_at:Date|null;discovered_at:Date;ready_at:Date|null};

export const EDGE_GROUPS: Record<string, string> = { market: "市场资讯", company: "上市公司", research: "投资研究", macro: "政策与宏观", global: "海外金融" };
export const EDGE_CATEGORIES: Record<string, string> = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
/**
 * The domains on the public site: finance always, the others once listed in FINHOT_PUBLIC_DOMAINS
 * (comma separated, e.g. "ai"). Until then the site, its feed and its reports are finance only.
 */
export function publicDomains(env: string | undefined = process.env.FINHOT_PUBLIC_DOMAINS): DomainKey[] {
  const listed = new Set((env ?? "").split(",").map(d => d.trim()));
  return DOMAINS.map(d => d.key).filter(key => key === DEFAULT_DOMAIN || listed.has(key));
}
/** The domain catalog the website reads: key, names and the domain's categories, in display order. */
export function edgeDomains(keys: DomainKey[] = publicDomains()) {
  return DOMAINS.filter(d => keys.includes(d.key)).map(d => ({ key: d.key, label: d.label, labelEn: d.labelEn, categories: CATEGORIES.filter(c => c.domain === d.key).map(c => c.key) }));
}
/** The public feed keeps each domain's latest items, so a busy domain does not push a quiet one out. */
export const EDGE_FEED_LIMITS: Record<DomainKey, number> = { finance: 5000, ai: 3000 };
const sources = pack.sources.filter(s => s.enabled !== false && s.participation_mode === "editorial");
export const EDGE_SOURCE_IDS = sources.map(s => s.id);
/**
 * Sources the pack keeps unpublished (isolated or hot_signal there). The database may run one as editorial
 * on trial (AI from 2026-10-21): its items are processed but reach neither the website nor a report.
 */
export const WITHHELD_SOURCE_IDS = pack.sources.filter(s => s.participation_mode !== "editorial").map(s => s.id);

export async function edgeBudgetReached(db:Db=sql) {
  const [row] = await db<{ exhausted: boolean }[]>`
    SELECT b.per_day <= (SELECT count(*) FROM receipt_attempts a WHERE a.service=b.service AND a.origin='live' AND a.started_at>now()-interval '1 day')
      OR b.per_day=0 OR b.per_hour=0 OR b.per_minute=0
      OR (b.daily_cost_limit IS NOT NULL AND b.daily_cost_limit <= (SELECT coalesce(sum(coalesce(a.cost,a.reserved_cost)),0)
          FROM receipt_attempts a WHERE a.service=b.service AND a.origin='live' AND a.started_at>now()-interval '1 day')) AS exhausted
    FROM budgets b WHERE b.service='llm'`;
  return row?.exhausted ?? false;
}

async function readItems(options: { all?: boolean; group?: string; source?: string; category?: string; domain?: DomainKey; search?: string; offset?: number; ids?: string[]; limit?: number; changedSince?:string;from?:Date;until?:Date },db:Db,max:number) {
  const sourceIds = sources.filter(s => (!options.group || s.free?.group === options.group) && (!options.source || s.id === options.source)).map(s => s.id);
  const now = new Date(), limit = options.ids?Math.max(1,Math.min(500,options.ids.length)):Math.min(max, options.limit ?? 20);
  const term = options.search?.replace(/[\\%_]/g, c => `\\${c}`);
  const rows = await db<EdgeItem[]>`
    SELECT p.article_id AS id,p.url,s.id AS source_id,s.name AS source_name,
      coalesce(p.title,p.original_title) AS title,coalesce(p.original_title,p.title) AS original_title,coalesce(p.summary,'') AS summary,coalesce(p.category,'') AS category,p.selected::int AS selected,
      p.published_at,p.discovered_at,greatest(p.updated_at,e.updated_at) AS ready_at,
      nullif(e.title_en,'') AS title_en,nullif(e.summary_en,'') AS summary_en,
      CASE WHEN p.eligible THEN 'ready' WHEN a.body_status='pending' THEN 'awaiting-body'
           WHEN length(coalesce(a.body_text,a.excerpt,''))>=50 THEN 'pending' ELSE 'source-only' END AS state,
      CASE WHEN a.body_status='ok' OR (a.material_scope<>'' AND a.body_text IS NOT NULL) THEN 'fetched'
           WHEN a.body_status='unconfirmed' THEN 'failed' ELSE a.body_status END AS body_status,
      length(coalesce(a.body_text,'')) AS body_length,a.material_scope,p.domains,p.primary_domain
    FROM publications p JOIN sources s ON s.id=p.source_id JOIN articles a ON a.id=p.article_id
    LEFT JOIN public_copy_en e ON e.article_id=p.article_id AND e.source_title=coalesce(p.title,p.original_title) AND e.source_summary=coalesce(p.summary,'')
    WHERE ${options.all ? listedCondition(now) : selectedCondition(now)} AND s.enabled AND s.participation_mode='editorial'
      AND s.id=ANY(${sourceIds}::text[])
      ${options.category ? sql`AND p.category=${options.category}` : sql``}
      ${options.domain ? sql`AND p.domains @> ARRAY[${options.domain}]::text[]` : sql``}
      ${term ? sql`AND (p.title ILIKE ${'%' + term + '%'} OR p.original_title ILIKE ${'%' + term + '%'} OR coalesce(p.summary,'') ILIKE ${'%' + term + '%'})` : sql``}
      ${options.ids ? sql`AND p.article_id=ANY(${options.ids}::text[])` : sql``}
      ${options.changedSince?sql`AND (p.updated_at>=${options.changedSince}::timestamptz OR p.visible_after>=${options.changedSince}::timestamptz OR e.updated_at>=${options.changedSince}::timestamptz)`:sql``}
      ${options.from?sql`AND p.discovered_at>=${options.from} AND NOT p.backfill AND (p.published_at IS NULL OR p.published_at>=${options.from}::timestamptz-interval '48 hours')`:sql``}
      ${options.until?sql`AND p.discovered_at<${options.until}`:sql``}
    ORDER BY coalesce(p.published_at,p.discovered_at) DESC,p.article_id DESC LIMIT ${limit+1} OFFSET ${options.offset ?? 0}`;
  return { items: rows.slice(0,limit).map(({domains:stored,primary_domain,...row})=>{
    const listed=(stored??[]).filter(isDomainKey),primary=isDomainKey(primary_domain)?primary_domain:listed[0]??DEFAULT_DOMAIN,domains=listed.length?listed:[primary];
    // A finance-only item carries no domain fields (absent means finance), so its synced JSON and
    // hash stay as they were before domains and the deploy does not re-upload the whole feed.
    const own=domains.length===1&&domains[0]===DEFAULT_DOMAIN?{}:{domains,primary_domain:primary};
    return {...row,...own,category:basicCategory(row.source_id,row.original_title||row.title,row.category,primary)};
  }), hasMore: rows.length>limit, summaryBudgetReached: await edgeBudgetReached(db) };
}
export async function edgeItems(options: Parameters<typeof readItems>[0]={}) { return readItems(options,sql,40); }

export async function edgeSources(db:Db=sql) {
  const now=new Date();
  const health = await db`
    SELECT s.id,s.last_fetch_at AS checked_at,s.last_error IS NOT NULL AS failed,
      (SELECT count(*)::int FROM publications p WHERE p.source_id=s.id AND ${listedCondition(now)}) AS count,
      (SELECT max(p.published_at) FROM publications p WHERE p.source_id=s.id AND ${listedCondition(now)}) AS latest_published_at
    FROM sources s WHERE s.enabled AND s.id=ANY(${EDGE_SOURCE_IDS}::text[])`;
  const shown=publicDomains();
  // Only the public domains' categories: a site that predates domains lists every category it gets.
  const categories=Object.fromEntries(CATEGORIES.filter(c=>shown.includes(c.domain)).map(c=>[c.key,c.label]));
  return { sources: sources.filter(s => health.some(h => h.id===s.id)&&sourceDomains(s.id).some(d=>shown.includes(d))).map(s => ({ id:s.id,name:s.name,tier:s.tier,group:s.free?.group,homepage:s.free?.homepage,intervalMinutes:s.interval_minutes,domains:sourceDomains(s.id),...health.find(h=>h.id===s.id) })),categories,groups:EDGE_GROUPS,domains:edgeDomains(shown) };
}

/** Only public DTOs leave the server. A repeatable-read transaction captures one publication state. */
export function sourceIndex(items:any[],limit=20):any[]{
  const sorted=[...items].sort((a,b)=>Number(!!b.summary)-Number(!!a.summary));
  const groups=new Map<string,any[]>();for(const item of sorted){const list=groups.get(item.source_id)??[];list.push(item);groups.set(item.source_id,list);}
  const result:any[]=[];while(result.length<limit){let added=false;for(const list of groups.values()){if(list.length&&result.length<limit){result.push(list.shift());added=true;}}if(!added)break;}
  return result;
}
export async function edgeSnapshot(options:{since?:string;reconcileCursor?:string;reportCursor?:string}={}) {
  return sql.begin(async tx=>{
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const capturedAt=new Date().toISOString();
    // The feed: each domain's latest items, merged newest first (an item in two domains counts once).
    const shown=publicDomains();
    const feeds=await Promise.all(shown.map(d=>readItems({all:true,domain:d,limit:EDGE_FEED_LIMITS[d]},tx,EDGE_FEED_LIMITS[d])));
    const summaryBudgetReached=feeds.some(f=>f.summaryBudgetReached);
    const items=[...new Map(feeds.flatMap(f=>f.items).map(i=>[i.id,i])).values()]
      .sort((a,b)=>(+(b.published_at??b.discovered_at)-+(a.published_at??a.discovered_at))||(a.id<b.id?1:a.id>b.id?-1:0));
    // One row per occurrence in the feed (events/fold.ts); the folded reports stay public by address.
    const folds=await tx<FoldRow[]>`SELECT p.article_id AS id,a.feed_cluster,p.story_id,p.selected,p.score::float AS score,coalesce(p.published_at,p.discovered_at) AS at
      FROM publications p JOIN articles a ON a.id=p.article_id WHERE p.article_id=ANY(${items.map(i=>i.id)}::text[])`;
    const shownIds=process.env.FINHOT_FEED_FOLD==='false'?null:feedRepresentatives(folds);
    const changed=await readItems({all:true,limit:10000,changedSince:options.since??new Date(Date.now()-5*60000).toISOString()},tx,10000);
    if(changed.hasMore)throw new Error('Archive reconciliation requires batching; refusing a truncated publication');
    const visible=await tx`SELECT p.article_id AS id FROM publications p JOIN sources s ON s.id=p.source_id
      WHERE ${listedCondition(new Date())} AND s.enabled AND s.participation_mode='editorial' AND s.id=ANY(${EDGE_SOURCE_IDS}::text[])`;
    const visibleIds=new Set<string>(visible.map(r=>r.id).sort());
    const archived=new Map([...changed.items,...items].map(i=>[i.id,i]));
    // Check a bounded piece of history each round, including edits outside the recent feed.
    const reconcileIds=[...visibleIds].filter(id=>id>(options.reconcileCursor??'')).slice(0,500);
    const reconciled=await readItems({all:true,ids:reconcileIds},tx,500);
    for(const item of reconciled.items)archived.set(item.id,item);
    const reconcileCursor=reconcileIds.length===500?reconcileIds.at(-1):'';
    const catalog=await edgeSources(tx);
    // Older daily reports are re-sent a few at a time (the cursor walks finance's; another domain's reports
    // are recent enough to stay inside the last 30 of their kind).
    const reportKeys=await tx<{key:string}[]>`SELECT key FROM reports WHERE kind='daily' AND key>${options.reportCursor??''} ORDER BY key LIMIT 5`;
    const reportCursor=reportKeys.length===5?reportKeys.at(-1)!.key:'';
    const reports:Array<{key:string;generated_at:Date;content:any;domain:DomainKey}>=[];
    for(const d of DOMAINS.filter(d=>shown.includes(d.key))){
      const kind=reportKind('daily',d.key),walked=d.key===DEFAULT_DOMAIN?reportKeys.map(r=>r.key):[];
      const rows=await tx<{key:string;generated_at:Date;content:any}[]>`SELECT key,generated_at,content FROM reports WHERE kind=${kind}
        AND (key IN(SELECT key FROM reports WHERE kind=${kind} ORDER BY key DESC LIMIT 30) OR key=ANY(${walked}::text[]) OR generated_at>=${options.since??capturedAt}::timestamptz) ORDER BY key DESC`;
      reports.push(...rows.map(r=>({...r,domain:d.key})));
    }
    const reportDtos=[];
    for(const r of reports){
      const ids=[...new Set<string>([...(r.content.sections??[]).flatMap((s:any)=>s.items??[]),...(r.content.flashes??[])].map((i:any)=>i.itemId).filter((id:string)=>visibleIds.has(id)))].slice(0,500);
      for(let i=0;i<ids.length;i+=500){const extra=await readItems({ids:ids.slice(i,i+500),all:true},tx,500);for(const item of extra.items)archived.set(item.id,item);}
      const selectedIds=ids.filter(id=>archived.get(id)?.selected);
      const end=new Date(r.key+'T08:00:00+08:00'),start=new Date(end.getTime()-86400000);
      let fallback:any[]=[];
      if(!selectedIds.length){const candidates=await readItems({all:true,limit:200,from:start,until:end,domain:r.domain},tx,200);fallback=sourceIndex(candidates.items);for(const item of fallback)archived.set(item.id,item);}
      reportDtos.push({date:r.key,domain:r.domain,created_at:r.generated_at.toISOString(),ids:selectedIds.length?selectedIds:fallback.map(i=>i.id),
        mode:selectedIds.length?'selected':'source-index',windowStart:start.toISOString(),windowEnd:end.toISOString()});
    }
    const budgets=await tx`SELECT b.service,b.per_minute,b.per_hour,b.per_day,b.daily_cost_limit,b.cost_currency,
      (SELECT count(*)::int FROM receipt_attempts a WHERE a.service=b.service AND a.origin='live' AND a.started_at>now()-interval '1 day') AS used,
      (SELECT coalesce(sum(coalesce(a.cost,a.reserved_cost)),0) FROM receipt_attempts a WHERE a.service=b.service AND a.origin='live' AND a.started_at>now()-interval '1 day') AS cost
      FROM budgets b ORDER BY b.service`;
    const coverage={total:items.length,summaries:items.filter(i=>i.summary.trim()).length,bodies:items.filter(i=>i.body_status==='fetched').length,
      awaitingBody:items.filter(i=>i.state==='awaiting-body').length,awaitingSummary:items.filter(i=>!i.summary.trim()&&i.body_status==='fetched').length,
      unavailableBody:items.filter(i=>['failed','too-large','no-text'].includes(i.body_status)).length};
    return JSON.parse(JSON.stringify({capturedAt,items:[...archived.values()],feedIds:items.filter(i=>!shownIds||shownIds.has(i.id)).map(i=>i.id),visibleIds:[...visibleIds],reconcileCursor,reportCursor,
      metadata:{...catalog,archiveMode:'persistent',coverage,summaryBudgetReached,budgets,reports:reportDtos}}));
  });
}

export async function edgeReports(date?: string, domain: DomainKey = DEFAULT_DOMAIN) {
  const kind = reportKind("daily", domain);
  if (!date) return (await reportIndexRows(kind,30)).map(r => ({ date:r.key,created_at:r.generated_at,count:(r.content.sections ?? []).flatMap((s: any)=>s.items ?? []).length }));
  const report = await loadReport(kind,date);
  if (!report) return null;
  const ids = [...new Set([...report.sections.flatMap(s=>s.items),...report.flashes].filter(i=>i.available && i.itemId).map(i=>i.itemId!))];
  const { items } = await edgeItems({ ids,limit:40,domain });
  return { date,created_at:report.generatedAt,items };
}
