// Cloudflare serves only a replica of DTOs exported by the PostgreSQL publication boundary.
import type { D1Database } from '@cloudflare/workers-types';
import { escapeXml } from './free.ts';
import { clusterItemsWithMap, clusterReportItems, type RelatedItemBrief } from './cluster.ts';
export interface SyncDomain {key:string;label:string;labelEn:string;categories:string[]}
/** A daily edition's written review: headline, overview and themes, each citing items of the edition. */
export interface SyncReview {headline:string;overview:string;themes:Array<{heading:string;summary:string;ids:string[]}>}
export interface SyncMetadata {
  sources: Array<{id:string;name:string;group:string;homepage:string;tier:string;intervalMinutes:number;domains?:string[];[key:string]:unknown}>;
  categories: Record<string,string>; groups:Record<string,string>;
  /** The domain catalog (absent before domains: everything is finance). */
  domains?:SyncDomain[];
  /** Daily reports; `domain` absent means finance. A `review` edition lists its cited items first, then the selected. */
  reports:Array<{date:string;domain?:string;created_at:string;ids:string[];mode?:'selected'|'source-index'|'review';windowStart?:string;windowEnd?:string;review?:SyncReview}>;
  archiveMode?:'persistent';
  summaryBudgetReached:boolean; budgets:unknown[];
  coverage?:{total:number;summaries:number;bodies:number;awaitingBody:number;awaitingSummary:number;unavailableBody:number};
}
export interface SyncItem {
  id:string;url:string;source_id:string;source_name:string;title:string;summary:string;category:string;selected:number;
  published_at:string|null;discovered_at:string;ready_at:string|null;state:string;body_status:string;body_length:number;material_scope:string;
  original_title?:string;
  title_en?:string|null;summary_en?:string|null;
  /** The item's domains, ranked (the first is the primary); absent on items synced before domains (finance). */
  domains?:string[];primary_domain?:string;
  /** Other outlets covering the same occurrence within the window ("同题多源"). */
  related_items?:RelatedItemBrief[];
}
export async function syncedState(db:D1Database) {
  const row=await db.prepare("SELECT generation,captured_at,contact_at,metadata_json FROM server_sync_state WHERE key='active'").first<{generation:string;captured_at:string;contact_at:string;metadata_json:string}>();
  return row?{generation:row.generation,capturedAt:row.captured_at,contactAt:row.contact_at,metadata:JSON.parse(row.metadata_json) as SyncMetadata}:null;
}
export function syncedHealth(state:NonNullable<Awaited<ReturnType<typeof syncedState>>>,now=Date.now()) {
  const overdue=state.metadata.sources.filter(s=>typeof s.checked_at!=='string'||now-Date.parse(s.checked_at)>Math.max(45,s.intervalMinutes*3)*60000);
  const failed=state.metadata.sources.filter(s=>s.failed===true);
  return {ok:true,edition:'server-sync',syncedAt:state.capturedAt,lastContactAt:state.contactAt,
    stale:now-Date.parse(state.contactAt)>15*60000,
    collectionDelayed:!!state.metadata.sources.length&&overdue.length===state.metadata.sources.length,
    overdueSources:overdue.length,failedSources:failed.length,sourceCount:state.metadata.sources.length,
    summaryBudgetReached:state.metadata.summaryBudgetReached,coverage:state.metadata.coverage,
    indexLimit:5000,reportLimit:30,searchScope:'titles-and-summaries'};
}
/** The domain every item belonged to before domains; filtering by it reads the plain indexes. */
export const DEFAULT_SYNC_DOMAIN='finance';
/** Domain keys are inlined into SQL (a partial index is only used for the literal expression). */
export const SYNC_DOMAIN_KEY=/^[a-z]{1,20}$/;
export const domainOfReport=(report:{domain?:string})=>report.domain??DEFAULT_SYNC_DOMAIN;
export async function syncedItems(db:D1Database,options:{all?:boolean;category?:string;domain?:string;sourceIds?:string[];search?:string;offset?:number;limit?:number;from?:string}={}) {
  const where=[options.all?'1=1':'selected=1'],args:(string|number)[]=[];
  // Walk the matching date/source/category index and stop at the page boundary.
  // An IN subquery makes SQLite materialize the entire feed and sort every row.
  where.push('EXISTS(SELECT 1 FROM server_sync_recent r WHERE r.id=server_sync_items.id)');
  if(options.from){where.push('sort_at>=?');args.push(options.from);}
  if(options.category){where.push('category=?');args.push(options.category);}
  if(options.domain){if(!SYNC_DOMAIN_KEY.test(options.domain))throw new TypeError('Invalid domain');where.push(`domains LIKE '%,${options.domain},%'`);}
  if(options.sourceIds){where.push(options.sourceIds.length?`source_id IN (${options.sourceIds.map(()=>'?').join(',')})`:'0=1');args.push(...options.sourceIds);}
  // Literal substring search avoids D1's 50-byte LIKE pattern limit, including long Chinese terms.
  if(options.search){where.push('instr(lower(search_text),lower(?))>0');args.push(options.search);}
  const limit=Math.max(1,Math.min(40,options.limit??20)),offset=options.offset??0;
  const sqlText=`SELECT data_json FROM server_sync_items WHERE ${where.join(' AND ')} ORDER BY sort_at DESC,id DESC LIMIT ? OFFSET ?`;
  const rows=await db.prepare(sqlText).bind(...args,limit+1,offset).all<{data_json:string}>();
  const parsed=rows.results.map(r=>JSON.parse(r.data_json) as SyncItem);
  let res=clusterItemsWithMap(parsed,undefined,limit);
  let exhausted=rows.results.length<=limit;
  if(!res.hasMoreClusters&&!exhausted){
    const extraCount=Math.min(40,(limit-res.items.length)*3+6);
    const extra=await db.prepare(sqlText).bind(...args,extraCount,offset+limit+1).all<{data_json:string}>();
    if(extra.results.length<extraCount)exhausted=true;
    res=clusterItemsWithMap([...parsed,...extra.results.map(r=>JSON.parse(r.data_json) as SyncItem)],undefined,limit);
  }
  const hasMore=res.hasMoreClusters||!exhausted;
  return{items:res.items.slice(0,limit),hasMore,nextOffset:offset+res.consumedCount};
}
export async function syncedReport(db:D1Database,report:SyncMetadata['reports'][number]) {
  // Joining the current published replica means a withdrawn citation vanishes from old reports too.
  const selWhere=(report.mode??'selected')==='selected'?'selected=1':'1=1';
  const rows=await db.prepare(`SELECT data_json FROM server_sync_items WHERE ${selWhere} AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(report.ids)).all<{data_json:string}>();
  const byId=new Map(rows.results.map(r=>{const item=JSON.parse(r.data_json) as SyncItem;return[item.id,item];}));
  const rawItems=report.ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
  const citedIds=new Set<string>((report.review?.themes??[]).flatMap(t=>t.ids).filter(id=>byId.has(id)));
  const dom=domainOfReport(report);
  let windowCandidates:SyncItem[]=[];
  if(report.windowStart&&report.windowEnd&&SYNC_DOMAIN_KEY.test(dom)){
    const domWhere=dom===DEFAULT_SYNC_DOMAIN?`(domains IS NULL OR domains LIKE '%,finance,%')`:`domains LIKE '%,${dom},%'`;
    const winRows=await db.prepare(`SELECT data_json FROM server_sync_items WHERE ${selWhere} AND ${domWhere} AND sort_at>=? AND sort_at<=? ORDER BY sort_at DESC,id DESC LIMIT 120`).bind(report.windowStart,report.windowEnd).all<{data_json:string}>();
    windowCandidates=winRows.results
      .map(r=>JSON.parse(r.data_json) as SyncItem)
      .filter(c=>Boolean(c.summary&&c.summary.trim())&&/[\u3400-\u9fff]/.test(c.title||''));
  }
  const {items,representativeById}=clusterReportItems(rawItems,windowCandidates,Math.min(20,rawItems.length),citedIds);
  const shownById=new Set(items.map(i=>i.id));
  const review=report.review?{...report.review,themes:report.review.themes.map(t=>({...t,ids:[...new Set(t.ids.map(id=>representativeById.get(id)??id))].filter(id=>shownById.has(id))}))}:undefined;
  return{date:report.date,domain:dom,created_at:report.created_at,mode:report.mode??'selected',windowStart:report.windowStart,windowEnd:report.windowEnd,...(review?{review}:{}),items};
}
export async function syncedReportByDate(db:D1Database,date:string,domain=DEFAULT_SYNC_DOMAIN){
  const row=await db.prepare('SELECT data_json FROM server_sync_reports WHERE domain=? AND date=?').bind(domain,date).first<{data_json:string}>();
  return row?JSON.parse(row.data_json) as SyncMetadata['reports'][number]:null;
}
export async function syncedItem(db:D1Database,id:string):Promise<SyncItem|null> {
  const row=await db.prepare('SELECT data_json FROM server_sync_items WHERE id=?').bind(id).first<{data_json:string}>();
  return row?JSON.parse(row.data_json) as SyncItem:null;
}
export async function syncedSitemap(db:D1Database,state:NonNullable<Awaited<ReturnType<typeof syncedState>>>,site:string) {
  // Title-only entries have a useful source page, but are not advertised as original articles.
  const rows=await db.prepare("SELECT data_json FROM server_sync_items WHERE length(json_extract(data_json,'$.summary'))>0 ORDER BY sort_at DESC,id DESC LIMIT 5000").all<{data_json:string}>();
  const urls=[{path:'/',at:null},{path:'/all',at:null},{path:'/daily',at:null},{path:'/about',at:null},
    ...rows.results.map(r=>{const i=JSON.parse(r.data_json) as SyncItem;return{path:'/articles/'+encodeURIComponent(i.id),at:i.ready_at??i.discovered_at};}),
    ...(await db.prepare('SELECT domain,date,created_at FROM server_sync_reports ORDER BY date DESC,domain LIMIT 5000').all<{domain:string;date:string;created_at:string}>()).results.map(r=>({path:'/daily/'+r.date+(r.domain===DEFAULT_SYNC_DOMAIN?'':'?domain='+encodeURIComponent(r.domain)),at:r.created_at}))];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u=>`<url><loc>${escapeXml(new URL(u.path,site).href)}</loc>${u.at?`<lastmod>${escapeXml(u.at)}</lastmod>`:''}</url>`).join('')}</urlset>`;
}
/** The selected feed: /feed.xml stays finance (existing subscribers), /feed/<domain>.xml for the others. The last
 * week's written daily briefs come first, each with its whole review. */
export async function syncedRss(db:D1Database,site:string,domain:{key:string;label:string}={key:DEFAULT_SYNC_DOMAIN,label:'金融'}) {
  const {items}=await syncedItems(db,{limit:30,domain:domain.key});
  const label=domain.label,link=domain.key===DEFAULT_SYNC_DOMAIN?site:new URL('/?domain='+encodeURIComponent(domain.key),site).href;
  const briefs=(await db.prepare('SELECT data_json FROM server_sync_reports WHERE domain=? ORDER BY date DESC LIMIT 7').bind(domain.key).all<{data_json:string}>()).results
    .map(r=>JSON.parse(r.data_json) as SyncMetadata['reports'][number]).filter(r=>r.review);
  const brief=(r:SyncMetadata['reports'][number])=>{
    const url=new URL('/daily/'+r.date+(domain.key===DEFAULT_SYNC_DOMAIN?'':'?domain='+encodeURIComponent(domain.key)),site).href,v=r.review!;
    const html=`<p>${escapeXml(v.overview)}</p>${v.themes.map(t=>`<h3>${escapeXml(t.heading)}</h3><p>${escapeXml(t.summary)}</p>`).join('')}`;
    return `<item><title>${escapeXml(`每日${label}简报 ${r.date}${v.headline?'：'+v.headline:''}`)}</title><link>${escapeXml(url)}</link><guid isPermaLink="false">${escapeXml(`brief:${domain.key}:${r.date}`)}</guid><description>${escapeXml(html)}</description><pubDate>${new Date(r.created_at).toUTCString()}</pubDate></item>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>FinHot · ${escapeXml(label)}精选</title><link>${escapeXml(link)}</link><description>${escapeXml(label)}资讯中文摘要与原文索引</description><language>zh-cn</language>${briefs.map(brief).join('')}${items.map(i=>`<item><title>${escapeXml(i.title)}</title><link>${escapeXml(i.url)}</link><guid isPermaLink="false">${escapeXml(i.id)}</guid><description>${escapeXml(i.summary)}</description><pubDate>${new Date(i.published_at??i.discovered_at).toUTCString()}</pubDate><source>${escapeXml(i.source_name)}</source></item>`).join('')}</channel></rss>`;
}
