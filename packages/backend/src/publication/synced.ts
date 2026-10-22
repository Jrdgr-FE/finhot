// Cloudflare serves only a replica of DTOs exported by the PostgreSQL publication boundary.
import type { D1Database } from '@cloudflare/workers-types';
import { escapeXml } from './free.ts';
export interface SyncDomain {key:string;label:string;labelEn:string;categories:string[]}
export interface SyncMetadata {
  sources: Array<{id:string;name:string;group:string;homepage:string;tier:string;intervalMinutes:number;domains?:string[];[key:string]:unknown}>;
  categories: Record<string,string>; groups:Record<string,string>;
  /** The domain catalog (absent before domains: everything is finance). */
  domains?:SyncDomain[];
  /** Daily reports; `domain` absent means finance. */
  reports:Array<{date:string;domain?:string;created_at:string;ids:string[];mode?:'selected'|'source-index';windowStart?:string;windowEnd?:string}>;
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
  const limit=Math.max(1,Math.min(40,options.limit??20));
  const rows=await db.prepare(`SELECT data_json FROM server_sync_items WHERE ${where.join(' AND ')} ORDER BY sort_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...args,limit+1,options.offset??0).all<{data_json:string}>();
  return{items:rows.results.slice(0,limit).map(r=>JSON.parse(r.data_json) as SyncItem),hasMore:rows.results.length>limit};
}
export async function syncedReport(db:D1Database,report:SyncMetadata['reports'][number]) {
  // Joining the current published replica means a withdrawn citation vanishes from old reports too.
  const rows=await db.prepare(`SELECT data_json FROM server_sync_items WHERE ${report.mode==='source-index'?'1=1':'selected=1'} AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(report.ids)).all<{data_json:string}>();
  const byId=new Map(rows.results.map(r=>{const item=JSON.parse(r.data_json) as SyncItem;return[item.id,item];}));
  return{date:report.date,domain:domainOfReport(report),created_at:report.created_at,mode:report.mode??'selected',windowStart:report.windowStart,windowEnd:report.windowEnd,items:report.ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[])};
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
/** The selected feed: /feed.xml stays finance (existing subscribers), /feed/<domain>.xml for the others. */
export async function syncedRss(db:D1Database,site:string,domain:{key:string;label:string}={key:DEFAULT_SYNC_DOMAIN,label:'金融'}) {
  const {items}=await syncedItems(db,{limit:30,domain:domain.key});
  const label=domain.label,link=domain.key===DEFAULT_SYNC_DOMAIN?site:new URL('/?domain='+encodeURIComponent(domain.key),site).href;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>FinHot · ${escapeXml(label)}精选</title><link>${escapeXml(link)}</link><description>${escapeXml(label)}资讯中文摘要与原文索引</description><language>zh-cn</language>${items.map(i=>`<item><title>${escapeXml(i.title)}</title><link>${escapeXml(i.url)}</link><guid isPermaLink="false">${escapeXml(i.id)}</guid><description>${escapeXml(i.summary)}</description><pubDate>${new Date(i.published_at??i.discovered_at).toUTCString()}</pubDate><source>${escapeXml(i.source_name)}</source></item>`).join('')}</channel></rss>`;
}
