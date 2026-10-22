import type { D1Database } from '@cloudflare/workers-types';
import { SYNC_DOMAIN_KEY,type SyncItem,type SyncMetadata } from '../../packages/backend/src/publication/synced.ts';
export const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
export const digest=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function secretMatches(supplied:string|null,secret:string|undefined){return!!secret&&secret.length>=12&&!!supplied&&(await digest(supplied))===(await digest(secret));}
export async function readJson(request:Request,max=262144){
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new TypeError('JSON required');
  const reader=request.body?.getReader();if(!reader)throw new TypeError('Body required');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max)throw new TypeError('Body too large');chunks.push(next.value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
const identity=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v);
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const domainKey=(v:unknown)=>typeof v==='string'&&SYNC_DOMAIN_KEY.test(v);
const domainList=(v:unknown)=>Array.isArray(v)&&v.length>0&&v.length<=8&&v.every(domainKey)&&new Set(v).size===v.length;
/** Limits of one snapshot: the feed keeps each domain's latest items (finance 5,000, AI 3,000). */
export const FEED_LIMIT=8000,SOURCE_LIMIT=150;
function metadataOf(m:SyncMetadata):SyncMetadata {
  const labels=(v:Record<string,string>)=>{if(Object.keys(v).length>100||Object.entries(v).some(([k,s])=>!identity(k)||typeof s!=='string'||s.length>200))throw new TypeError('Invalid labels');return v;};
  const coverage=m.coverage?Object.fromEntries(['total','summaries','bodies','awaitingBody','awaitingSummary','unavailableBody'].map(k=>{
    const n=m.coverage![k as keyof NonNullable<SyncMetadata['coverage']>];if(!Number.isInteger(n)||n<0||n>FEED_LIMIT)throw new TypeError('Invalid coverage');return[k,n];
  })) as SyncMetadata['coverage']:undefined;
  const domains=m.domains===undefined?undefined:m.domains.map(d=>{
    if(!domainKey(d?.key)||typeof d.label!=='string'||d.label.length>40||typeof d.labelEn!=='string'||d.labelEn.length>60||!Array.isArray(d.categories)||d.categories.length>50||!d.categories.every(c=>identity(c)&&Object.hasOwn(m.categories,c)))throw new TypeError('Invalid domain');
    return {key:d.key,label:d.label,labelEn:d.labelEn,categories:[...d.categories]};
  });
  if(domains&&(domains.length>8||new Set(domains.map(d=>d.key)).size!==domains.length))throw new TypeError('Invalid domains');
  return {sources:m.sources.map(s=>{
    if(!/^https?:\/\//.test(s.homepage)||!Number.isInteger(s.intervalMinutes)||s.intervalMinutes<1||(s.domains!==undefined&&!domainList(s.domains)))throw new TypeError('Invalid source');
    return Object.fromEntries(['id','name','group','homepage','tier','intervalMinutes','domains','checked_at','failed','count','latest_published_at'].filter(k=>Object.hasOwn(s,k)).map(k=>[k,s[k]])) as SyncMetadata['sources'][number];
  }),categories:labels(m.categories),groups:labels(m.groups),...(domains?{domains}:{}),reports:m.reports.map(r=>({date:r.date,...(r.domain?{domain:r.domain}:{}),created_at:r.created_at,ids:r.ids,mode:r.mode==='source-index'?'source-index':'selected',...(r.windowStart?{windowStart:r.windowStart,windowEnd:r.windowEnd}:{})})),summaryBudgetReached:m.summaryBudgetReached,
    ...(m.archiveMode==='persistent'?{archiveMode:'persistent' as const}:{}),
    coverage,budgets:m.budgets.map((b:any)=>Object.fromEntries(['service','per_minute','per_hour','per_day','daily_cost_limit','cost_currency','used','cost'].filter(k=>Object.hasOwn(b,k)).map(k=>[k,b[k]])))};
}
function itemOf(value:any,sourceIds:Set<string>):SyncItem{
  const fields=['id','url','source_id','source_name','title','original_title','title_en','summary_en','summary','category','selected','published_at','discovered_at','ready_at','state','body_status','body_length','material_scope','domains','primary_domain'];
  if(value?.domains!==undefined&&(!domainList(value.domains)||!value.domains.includes(value.primary_domain)))throw new TypeError('Invalid domains');
  for(const key of ['title_en','summary_en'])if(value?.[key]!=null&&(typeof value[key]!=='string'||value[key].length>(key==='title_en'?1500:8000)||/[\u3400-\u9fff]/u.test(value[key])))throw new TypeError('Invalid English copy');
  if(value?.original_title!==undefined&&(typeof value.original_title!=='string'||value.original_title.length>3000))throw new TypeError('Invalid original title');
  if(!value||!identity(value.id)||!sourceIds.has(value.source_id)||typeof value.url!=='string'||!/^https?:\/\//.test(value.url)||value.url.length>4096||typeof value.title!=='string'||!value.title.trim()||value.title.length>1000||typeof value.summary!=='string'||value.summary.length>5000||!time(value.discovered_at)||!(value.published_at===null||time(value.published_at))||!(value.ready_at===null||time(value.ready_at))||![0,1].includes(value.selected)||!['ready','awaiting-body','pending','source-only'].includes(value.state)||typeof value.source_name!=='string'||typeof value.category!=='string'||typeof value.material_scope!=='string'||value.material_scope.length>300||typeof value.body_status!=='string'||!Number.isInteger(value.body_length)||value.body_length<0)throw new TypeError('Invalid published item');
  if((value.selected||value.state==='ready')&&!value.summary.trim())throw new TypeError('Summary missing');
  return Object.fromEntries(fields.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])) as unknown as SyncItem;
}
export async function syncApi(request:Request,db:D1Database,token:string|undefined){
  if(!await secretMatches(request.headers.get('authorization')?.replace(/^Bearer /,'')??null,token))return json({error:'Unauthorized'},401);
  const path=new URL(request.url).pathname;
  if(path==='/_sync/head'&&request.method==='GET'){const state=await db.prepare("SELECT generation FROM server_sync_state WHERE key='active'").first();return json(state??{generation:''});}
  if(path==='/_sync/catalog'&&request.method==='GET'){
    const after=new URL(request.url).searchParams.get('after')??'';if(after&&!identity(after))throw new TypeError('Invalid cursor');
    const table=new URL(request.url).searchParams.get('recent')==='1'?'server_sync_recent':'server_sync_items';
    const rows=await db.prepare(`SELECT id FROM ${table} WHERE id>? ORDER BY id LIMIT 1000`).bind(after).all<{id:string}>();
    return json({ids:rows.results.map(r=>r.id),next:rows.results.length===1000?rows.results.at(-1)!.id:null});
  }
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  const input=await readJson(request,path==='/_sync/begin'?8388608:262144),generation=input.generation;
  if(!identity(generation))throw new TypeError('Invalid generation');
  if(path==='/_sync/heartbeat'){
    const result=await db.prepare("UPDATE server_sync_state SET contact_at=? WHERE key='active' AND generation=?").bind(new Date().toISOString(),generation).run();
    return result.meta.changes?json({accepted:true}):json({error:'Snapshot changed'},409);
  }
  if(path==='/_sync/begin'){
    const {baseGeneration,capturedAt,expectedChanges,ids,metadata,feedIds,withdrawnIds=[],feedAddedIds=[],feedRemovedIds=[]}=input;
    const archive=metadata?.archiveMode==='persistent',maximum=archive?100000:FEED_LIMIT;
    if(typeof baseGeneration!=='string'||(baseGeneration&&!identity(baseGeneration))||!time(capturedAt)||Date.parse(capturedAt)>Date.now()+60000||!Number.isInteger(expectedChanges)||expectedChanges<0||expectedChanges>maximum||!Array.isArray(ids)||ids.length>maximum||new Set(ids).size!==ids.length||!ids.every(identity)||!metadata||!Array.isArray(metadata.sources)||metadata.sources.length>SOURCE_LIMIT||!metadata.sources.every((s:any)=>identity(s.id)&&typeof s.name==='string'&&typeof s.group==='string')||!Array.isArray(metadata.reports)||metadata.reports.length>(archive?5000:30)||!Array.isArray(metadata.budgets)||typeof metadata.summaryBudgetReached!=='boolean'||!metadata.categories||!metadata.groups)throw new TypeError('Invalid snapshot metadata');
    const allowedIds=new Set(ids),feedSet=new Set(Array.isArray(feedIds)?feedIds:[]);
    if(archive&&(!Array.isArray(feedIds)||feedIds.length>FEED_LIMIT||feedSet.size!==feedIds.length||!feedIds.every((id:string)=>allowedIds.has(id))||!Array.isArray(withdrawnIds)||withdrawnIds.length>100000||new Set(withdrawnIds).size!==withdrawnIds.length||!withdrawnIds.every(identity)||withdrawnIds.some((id:string)=>allowedIds.has(id))))throw new TypeError('Invalid archive manifest');
    if(archive&&(!Array.isArray(feedAddedIds)||feedAddedIds.length>FEED_LIMIT||!feedAddedIds.every((id:string)=>feedSet.has(id))||!Array.isArray(feedRemovedIds)||feedRemovedIds.length>FEED_LIMIT||!feedRemovedIds.every(identity)||feedRemovedIds.some((id:string)=>feedSet.has(id))))throw new TypeError('Invalid feed changes');
    const previous=await db.prepare("SELECT metadata_json FROM server_sync_state WHERE key='active'").first<{metadata_json:string}>();
    if(!archive&&previous&&JSON.parse(previous.metadata_json).archiveMode==='persistent')return json({error:'Persistent archive requires the archive protocol'},409);
    if(metadata.reports.some((r:any)=>!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||(r.domain!==undefined&&!domainKey(r.domain))||!time(r.created_at)||!Array.isArray(r.ids)||r.ids.length>500||!r.ids.every(identity)))throw new TypeError('Invalid reports');
    if(metadata.reports.some((r:any)=>r.windowStart&&(!time(r.windowStart)||!time(r.windowEnd)||r.windowStart>=r.windowEnd)))throw new TypeError('Invalid report window');
    const fingerprint=await digest(JSON.stringify(input));
    await db.prepare('INSERT INTO server_sync_versions(generation,base_generation,captured_at,expected_changes,ids_json,metadata_json,fingerprint,created_at,feed_ids_json,withdrawn_ids_json,feed_add_json,feed_remove_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(generation,baseGeneration,capturedAt,expectedChanges,JSON.stringify(ids),JSON.stringify(metadataOf(metadata)),fingerprint,new Date().toISOString(),archive?JSON.stringify(feedIds):null,JSON.stringify(archive?withdrawnIds:[]),JSON.stringify(feedAddedIds),JSON.stringify(feedRemovedIds)).run();
    const stored=await db.prepare('SELECT fingerprint FROM server_sync_versions WHERE generation=?').bind(generation).first<{fingerprint:string}>();
    return stored?.fingerprint===fingerprint?json({accepted:true}):json({error:'Generation conflict'},409);
  }
  const manifest=await db.prepare('SELECT * FROM server_sync_versions WHERE generation=?').bind(generation).first<{base_generation:string;captured_at:string;expected_changes:number;ids_json:string;metadata_json:string;feed_ids_json:string|null;withdrawn_ids_json:string;feed_add_json:string;feed_remove_json:string}>();
  if(!manifest)return json({error:'Begin snapshot first'},409);
  const active=await db.prepare("SELECT generation,captured_at FROM server_sync_state WHERE key='active'").first<{generation:string;captured_at:string}>();
  if(path==='/_sync/commit'&&active?.generation===generation)return json({accepted:true,reused:true});
  if((active?.generation??'')!==manifest.base_generation||active&&active.captured_at>=manifest.captured_at)return json({error:'Stale base snapshot'},409);
  if(path==='/_sync/items'){
    if(!Array.isArray(input.items)||input.items.length>30)throw new TypeError('Chunk too large');
    const metadata=JSON.parse(manifest.metadata_json) as SyncMetadata,allowed=new Set<string>(JSON.parse(manifest.ids_json)),sourceIds=new Set(metadata.sources.map(s=>s.id));
    const items=input.items.map((v:any)=>itemOf(v,sourceIds));if(items.some((i:SyncItem)=>!allowed.has(i.id)))throw new TypeError('Unexpected item');
    if(items.length)await db.batch(items.map((i:SyncItem)=>db.prepare('INSERT INTO server_sync_stage(generation,id,source_id,category,selected,sort_at,search_text,data_json,domains) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(generation,id) DO UPDATE SET source_id=excluded.source_id,category=excluded.category,selected=excluded.selected,sort_at=excluded.sort_at,search_text=excluded.search_text,data_json=excluded.data_json,domains=excluded.domains').bind(generation,i.id,i.source_id,i.category,i.selected,i.published_at??i.discovered_at,[i.title,i.original_title??'',i.summary,i.title_en??'',i.summary_en??''].join(' '),JSON.stringify(i),`,${(i.domains??['finance']).join(',')},`)));
    return json({accepted:true});
  }
  if(path!=='/_sync/commit')return json({error:'Not found'},404);
  // The active manifest already proved these IDs exist. Only that exact base can
  // commit below, and withdrawals cannot overlap its own manifest. Reuse this
  // proof instead of reading every unchanged item again on metadata-only syncs.
  // If an older deployment has no retained manifest, validate the whole set.
  const base=manifest.base_generation?await db.prepare('SELECT ids_json FROM server_sync_versions WHERE generation=?').bind(manifest.base_generation).first<{ids_json:string}>():null;
  const verified=new Set<string>(base?JSON.parse(base.ids_json):[]);
  const unchecked=(JSON.parse(manifest.ids_json) as string[]).filter(id=>!verified.has(id));
  const [count,missing]=await Promise.all([
    db.prepare('SELECT count(*) AS n FROM server_sync_stage WHERE generation=?').bind(generation).first<{n:number}>(),
    unchecked.length?db.prepare('SELECT count(*) AS n FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM server_sync_items i WHERE i.id=j.value) AND NOT EXISTS(SELECT 1 FROM server_sync_stage s WHERE s.generation=? AND s.id=j.value)').bind(JSON.stringify(unchecked),generation).first<{n:number}>():Promise.resolve({n:0}),
  ]);
  if(count?.n!==manifest.expected_changes||missing?.n!==0)return json({error:'Incomplete snapshot'},409);
  // D1 batch is a transaction. Every statement checks the same base; the active pointer changes last.
  const guard="EXISTS(SELECT 1 FROM server_sync_versions v WHERE v.generation=? AND v.base_generation=coalesce((SELECT generation FROM server_sync_state WHERE key='active'),'') AND v.expected_changes=(SELECT count(*) FROM server_sync_stage WHERE generation=v.generation))";
  await db.batch([
    db.prepare(`INSERT INTO server_sync_items(id,source_id,category,selected,sort_at,search_text,data_json,domains) SELECT id,source_id,category,selected,sort_at,search_text,data_json,domains FROM server_sync_stage WHERE generation=? AND ${guard} ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,category=excluded.category,selected=excluded.selected,sort_at=excluded.sort_at,search_text=excluded.search_text,data_json=excluded.data_json,domains=excluded.domains`).bind(generation,generation),
    manifest.feed_ids_json===null?db.prepare(`DELETE FROM server_sync_items WHERE id NOT IN(SELECT value FROM json_each(?)) AND ${guard}`).bind(manifest.ids_json,generation):db.prepare(`DELETE FROM server_sync_items WHERE id IN(SELECT value FROM json_each(?)) AND ${guard}`).bind(manifest.withdrawn_ids_json,generation),
    db.prepare(`DELETE FROM server_sync_recent WHERE ${manifest.feed_ids_json===null?'1=1':'id IN(SELECT value FROM json_each(?))'} AND ${guard}`).bind(...(manifest.feed_ids_json===null?[]:[manifest.feed_remove_json]),generation),
    db.prepare(`INSERT INTO server_sync_recent(id) SELECT value FROM json_each(?) WHERE ${guard} ON CONFLICT DO NOTHING`).bind(manifest.feed_ids_json===null?manifest.ids_json:manifest.feed_add_json,generation),
    db.prepare(`INSERT INTO server_sync_reports(domain,date,created_at,data_json) SELECT coalesce(json_extract(value,'$.domain'),'finance'),json_extract(value,'$.date'),json_extract(value,'$.created_at'),value FROM json_each(?,'$.reports') WHERE ${guard} ON CONFLICT(domain,date) DO UPDATE SET created_at=excluded.created_at,data_json=excluded.data_json WHERE server_sync_reports.data_json<>excluded.data_json`).bind(manifest.metadata_json,generation),
    db.prepare(`INSERT INTO server_sync_state(key,generation,captured_at,contact_at,metadata_json) SELECT 'active',generation,captured_at,?,metadata_json FROM server_sync_versions WHERE generation=? AND ${guard} ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,captured_at=excluded.captured_at,contact_at=excluded.contact_at,metadata_json=excluded.metadata_json`).bind(new Date().toISOString(),generation,generation),
  ]);
  const now=await db.prepare("SELECT generation FROM server_sync_state WHERE key='active'").first<{generation:string}>();
  return now?.generation===generation?json({accepted:true}):json({error:'Snapshot changed concurrently'},409);
}
