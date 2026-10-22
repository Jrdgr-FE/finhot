import type { D1Database } from '@cloudflare/workers-types';
import { syncedState,syncedItems,syncedItem,syncedReport,syncedReportByDate,syncedRss,syncedSitemap,syncedHealth,domainOfReport,DEFAULT_SYNC_DOMAIN,type SyncMetadata } from '../../packages/backend/src/publication/synced.ts';
import { syncApi,secretMatches,readJson,digest,json } from './sync-api.ts';
import { monitorSync } from './sync-monitor.ts';
import {articleHtml,reportHtml} from './public-html.ts';
import {cachedPublicRead,type PublicCache} from './public-cache.ts';
import {limited,secureHeaders,type RequestLimiter} from './security.ts';
interface Env{DB:D1Database;ASSETS?:{fetch(r:Request):Promise<Response>};CACHE?:PublicCache;AUTH_RATE_LIMITER?:RequestLimiter;PUBLIC_RATE_LIMITER?:RequestLimiter;ADMIN_PASSWORD?:string;SYNC_TOKEN?:string;PREVIEW_ONLY?:string;PUBLIC_ONLY?:string;SYNC_ONLY?:string;SITE_URL:string;}
async function admin(request:Request,env:Env){let value=request.headers.get('authorization')??'';if(value.startsWith('Basic ')){try{value='Bearer '+atob(value.slice(6)).split(':').slice(1).join(':');}catch{return false;}}return secretMatches(value.replace(/^Bearer /,''),env.ADMIN_PASSWORD);}
async function route(request:Request,env:Env):Promise<Response>{
  const u=new URL(request.url),p=u.pathname;
  // Do not challenge for passwords, inspect tokens or read the database over cleartext HTTP.
  if(u.protocol!=='https:')return json({error:'HTTPS required'},426);
  if(p.startsWith('/_sync/')){
    if(env.PUBLIC_ONLY==='true')return json({error:'Not found'},404);
    const blocked=await limited(request,env.AUTH_RATE_LIMITER,'sync');if(blocked)return blocked;
    return syncApi(request,env.DB,env.SYNC_TOKEN);
  }
  if(env.SYNC_ONLY==='true'||u.hostname==='sync.finhot.fun')return json({error:'Not found'},404);
  if(env.PREVIEW_ONLY==='true'||p.startsWith('/api/admin/')){
    const blocked=await limited(request,env.AUTH_RATE_LIMITER,env.PREVIEW_ONLY==='true'?'preview':'admin');if(blocked)return blocked;
  }
  if(env.PREVIEW_ONLY==='true'&&!await admin(request,env))return new Response('FinHot 内部预览需管理员验证',{status:401,headers:{'www-authenticate':'Basic realm="FinHot Preview"'}});
  if(p.startsWith('/api/admin/')){
    if(!await admin(request,env))return json({error:'请先登录管理员账户'},401);
    if(p!=='/api/admin/status'||request.method!=='GET')return json({error:'接口不存在'},404);
    const state=await syncedState(env.DB);const feedback=await env.DB.prepare('SELECT id,message,contact,created_at FROM feedback WHERE created_at>? ORDER BY created_at DESC LIMIT 30').bind(new Date(Date.now()-30*86400000).toISOString()).all();
    const incidents=await env.DB.prepare('SELECT kind,message,opened_at,last_seen_at,resolved_at FROM sync_incidents ORDER BY opened_at DESC LIMIT 30').all();
    return json({edition:'server-sync',health:state?syncedHealth(state):null,budgets:state?.metadata.budgets,sources:state?.metadata.sources,feedback:feedback.results,incidents:incidents.results,model:'仅服务器后台任务'});
  }
  if(p.startsWith('/api/')||p.startsWith('/articles/')||p.startsWith('/daily/')||p.startsWith('/feed/')||['/feed.xml','/sitemap.xml'].includes(p)){
    const blocked=await limited(request,env.PUBLIC_RATE_LIMITER,'public');if(blocked)return blocked;
  }
  if(p==='/api/feedback'&&request.method==='POST'){
    if(request.headers.get('origin')!==u.origin)return json({error:'请通过本站反馈页提交'},403);
    const input=await readJson(request,4096);if(input.website)return json({accepted:true});
    const message=String(input.message??'').trim(),contact=String(input.contact??'').trim();if(message.length<10||message.length>1500||contact.length>150)return json({error:'说明请写 10—1500 字，联系方式不超过 150 字'},400);
    const hour=Math.floor(Date.now()/3600000),key=await digest(`feedback:${hour}:${request.headers.get('cf-connecting-ip')??'local'}:${env.ADMIN_PASSWORD}`);
    const limit=await env.DB.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<5 RETURNING count').bind(key,(hour+2)*3600000).first();if(!limit)return json({error:'提交较频繁，请一小时后再试'},429);
    const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO feedback VALUES(?,?,?,?)').bind(id,message,contact,new Date().toISOString()).run();return json({accepted:true,id},201);
  }
  if(!['GET','HEAD'].includes(request.method))return json({error:'不支持的请求方式'},405);
  if(p==='/robots.txt')return new Response(`User-agent: *\nDisallow: /admin\nDisallow: /api/admin/\nDisallow: /_sync/\n${env.PREVIEW_ONLY==='true'?'Disallow: /\n':`Sitemap: ${new URL('/sitemap.xml',env.SITE_URL).href}\n`}`);
  if(p==='/llms.txt')return new Response('# FinHot\n按领域（AI 与硬科技、金融）整理的资讯中文摘要与原文索引。\n- 精选：/api/items?domain=ai 或 /api/items?domain=finance\n- 全部：/api/items?all=1&domain=ai\n- 日报：/api/reports?domain=ai\n- RSS：/feed.xml（金融）、/feed/ai.xml（AI 与硬科技）\n摘要由模型辅助生成，请核对原文。');
  if(!p.startsWith('/api/')&&!p.startsWith('/articles/')&&!p.startsWith('/daily/')&&!p.startsWith('/feed/')&&!['/feed.xml','/sitemap.xml'].includes(p))return env.ASSETS?env.ASSETS.fetch(request):json({error:'Not found'},404);
  const cache=env.CACHE??(globalThis as unknown as {caches?:{default:PublicCache}}).caches?.default;
  return cachedPublicRead(request,env.DB,cache,()=>readPublished(request,env),env.PREVIEW_ONLY==='true');
}
async function readPublished(request:Request,env:Env):Promise<Response>{
  // Detect a commit between metadata and item reads; retry rather than return mixed generations.
  for(let attempt=0;attempt<2;attempt++){
    const state=await syncedState(env.DB);if(!state)return json({error:'发布数据正在首次同步，请稍后重试'},503);
    const response=await publicRead(request,env,state);
    const head=await env.DB.prepare("SELECT generation FROM server_sync_state WHERE key='active'").first<{generation:string}>();
    if(head?.generation===state.generation){const headers=new Headers(response.headers);headers.set('x-finhot-generation',state.generation);return new Response(response.body,{status:response.status,headers});}
  }
  return json({error:'发布数据正在更新，请重试'},503);
}
/** The catalog's domains; a snapshot from before domains has only finance. */
function domainsOf(m:SyncMetadata){return m.domains?.length?m.domains:[{key:DEFAULT_SYNC_DOMAIN,label:'金融',labelEn:'Finance',categories:Object.keys(m.categories)}];}
async function publicRead(request:Request,env:Env,state:NonNullable<Awaited<ReturnType<typeof syncedState>>>):Promise<Response>{
  const u=new URL(request.url),p=u.pathname;
  const m=state.metadata,domains=domainsOf(m);
  // ?domain= picks a domain; reports and daily pages default to finance (old links), item lists to all.
  const domainParam=u.searchParams.get('domain')??'',domain=domains.find(d=>d.key===domainParam);
  if(domainParam&&!domain)return json({error:'无效领域'},400);
  const reportDomain=domain?.key??DEFAULT_SYNC_DOMAIN;
  if(p.startsWith('/articles/')){
    const id=/^\/articles\/([a-zA-Z0-9_-]{1,80})$/.exec(p)?.[1];
    if(!id)return json({error:'文章不存在'},404);
    const item=await syncedItem(env.DB,id);return item?articleHtml(item,m,env.SITE_URL,u.searchParams.get('lang')==='zh-CN'?'zh-CN':'en'):json({error:'文章不存在或已下架'},404);
  }
  if(p.startsWith('/daily/')){
    const date=p.slice(7),report=await syncedReportByDate(env.DB,date,reportDomain);
    return report?reportHtml(await syncedReport(env.DB,report),env.SITE_URL,u.searchParams.get('lang')==='zh-CN'?'zh-CN':'en',domains.find(d=>d.key===reportDomain)):json({error:'该日期还没有日报'},404);
  }
  if(p==='/sitemap.xml')return new Response(await syncedSitemap(env.DB,state,env.SITE_URL),{headers:{'content-type':'application/xml; charset=utf-8','cache-control':'no-store'}});
  if(p==='/api/health')return json(syncedHealth(state));
  if(p==='/api/sources')return json({sources:m.sources,categories:m.categories,groups:m.groups,domains});
  if(p==='/api/items'){
    const q=u.searchParams,category=q.get('category')??'',group=q.get('group')??'',source=q.get('source')??'',offset=Number(q.get('offset')??0),search=(q.get('q')??'').trim(),from=q.get('from')??'';
    if(from&&(!Number.isFinite(Date.parse(from))||new Date(from).toISOString()!==from))return json({error:'无效时间范围'},400);
    if(search.length>80)return json({error:'搜索关键词请控制在 80 字以内'},400);
    // A category must belong to the requested domain.
    if(!Number.isInteger(offset)||offset<0||offset>5000||category&&!Object.hasOwn(m.categories,category)||category&&domain&&!domain.categories.includes(category)||group&&!Object.hasOwn(m.groups,group)||source&&!m.sources.some(s=>s.id===source))return json({error:'无效筛选或分页'},400);
    const sourceIds=m.sources.filter(s=>(!group||s.group===group)&&(!source||s.id===source)).map(s=>s.id);
    // Before any other domain exists every item is finance: the plain indexes answer it.
    const filter=domain&&domains.length>1?domain.key:undefined;
    return json({...await syncedItems(env.DB,{all:q.get('all')==='1',category,domain:filter,sourceIds:group||source?sourceIds:undefined,search,offset,from:from||undefined}),summaryBudgetReached:m.summaryBudgetReached,syncedAt:state.capturedAt,health:syncedHealth(state),...(q.get('catalog')==='1'?{sources:m.sources,domains}: {})});
  }
  if(p==='/api/reports')return json({domain:reportDomain,reports:m.reports.filter(r=>domainOfReport(r)===reportDomain).slice(0,30).map(r=>({date:r.date,domain:domainOfReport(r),created_at:r.created_at,count:r.ids.length,mode:r.mode??'selected'}))});
  if(p.startsWith('/api/reports/')){const date=p.slice(13);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)return json({error:'无效日期'},400);const report=await syncedReportByDate(env.DB,date,reportDomain);return report?json(await syncedReport(env.DB,report)):json({error:'该日期还没有日报'},404);}
  if(p==='/feed.xml')return new Response(await syncedRss(env.DB,env.SITE_URL),{headers:{'content-type':'application/rss+xml; charset=utf-8','cache-control':'no-store'}});
  const feed=/^\/feed\/([a-z]{1,20})\.xml$/.exec(p)?.[1],feedDomain=domains.find(d=>d.key===feed&&d.key!==DEFAULT_SYNC_DOMAIN);
  if(feedDomain)return new Response(await syncedRss(env.DB,env.SITE_URL,feedDomain),{headers:{'content-type':'application/rss+xml; charset=utf-8','cache-control':'no-store'}});
  return json({error:'接口不存在'},404);
}
export default{
  async fetch(request:Request,env:Env){let response:Response;try{response=await route(request,env);}catch(e){response=json({error:e instanceof TypeError||e instanceof SyntaxError?'提交格式不正确或内容过长':'暂时无法完成请求，请稍后重试'},e instanceof TypeError||e instanceof SyntaxError?400:503);console.error('request failed',e instanceof Error?e.name:'unknown');}
    const headers=new Headers(response.headers);secureHeaders(headers,new URL(request.url).protocol==='https:');headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");if(env.PREVIEW_ONLY==='true'||env.SYNC_ONLY==='true'){headers.set('x-robots-tag','noindex, nofollow');headers.set('cache-control','no-store');}return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
  },
  // CROSS JOIN keeps the small versions table outermost: LIMIT alone can still
  // scan every unexpired staging row when SQLite reverses the join order.
  // Expired manifests (a day old, not active) give back their id lists at once, 200 a run: their staging rows
  // drain 100 a run, and a full manifest per sync filled the 500 MB database (HTTP 503 on sync, 2026-10-21).
  // A manifest begun before the active one is dead as soon as that one commits (its base can never be active
  // again), so it expires at once; a manifest begun later may still be uploading and keeps the day.
  async scheduled(_event:unknown,env:Env){await monitorSync(env.DB);const cutoff=new Date(Date.now()-30*86400000).toISOString(),old=new Date(Date.now()-86400000).toISOString();
    const expired=(c:string)=>`${c}<max(?,coalesce((SELECT a.created_at FROM server_sync_state t JOIN server_sync_versions a ON a.generation=t.generation WHERE t.key='active'),''))`;
    await env.DB.batch([env.DB.prepare('DELETE FROM feedback WHERE created_at<?').bind(cutoff),env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(Date.now()),env.DB.prepare("DELETE FROM sync_incidents WHERE resolved_at IS NOT NULL AND resolved_at<?").bind(cutoff),env.DB.prepare(`DELETE FROM server_sync_stage WHERE rowid IN(SELECT s.rowid FROM server_sync_versions v CROSS JOIN server_sync_stage s ON s.generation=v.generation WHERE ${expired('v.created_at')} AND v.generation<>coalesce((SELECT generation FROM server_sync_state WHERE key='active'),'') LIMIT 100)`).bind(old),env.DB.prepare(`DELETE FROM server_sync_versions WHERE ${expired('created_at')} AND generation<>coalesce((SELECT generation FROM server_sync_state WHERE key='active'),'') AND NOT EXISTS(SELECT 1 FROM server_sync_stage s WHERE s.generation=server_sync_versions.generation)`).bind(old),env.DB.prepare(`UPDATE server_sync_versions SET ids_json='[]',metadata_json='{}',feed_ids_json=NULL,withdrawn_ids_json='[]',feed_add_json='[]',feed_remove_json='[]' WHERE rowid IN(SELECT rowid FROM server_sync_versions WHERE ${expired('created_at')} AND generation<>coalesce((SELECT generation FROM server_sync_state WHERE key='active'),'') AND (ids_json<>'[]' OR metadata_json<>'{}') LIMIT 200)`).bind(old)]);},
};
