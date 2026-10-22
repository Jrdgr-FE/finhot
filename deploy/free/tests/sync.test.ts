import assert from 'node:assert/strict';
import {before,after,beforeEach,test} from 'node:test';
import {readFile,mkdtemp,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker from '../../ecs/cloudflare-sync-worker.ts';
import {pushSnapshot} from '../../ecs/push-public.ts';
import {syncedHealth,syncedItems} from '../../../packages/backend/src/publication/synced.ts';
import {monitorSync} from '../../ecs/sync-monitor.ts';
let mf:Miniflare,env:any,stateFile:string;
const token='sync-test-token-at-least-32-characters';
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-01',script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  const DB=await mf.getD1Database('DB');for(const sql of (await readFile(new URL('../../ecs/migrations/0001_sync.sql',import.meta.url),'utf8')).split(';').filter(s=>s.trim()))await DB.prepare(sql).run();
  for(const sql of (await readFile(new URL('../../ecs/migrations/0002_sync_incidents.sql',import.meta.url),'utf8')).split(';').filter(s=>s.trim()))await DB.prepare(sql).run();
  for(const name of ['0003_archive.sql','0004_domains.sql'])for(const sql of (await readFile(new URL('../../ecs/migrations/'+name,import.meta.url),'utf8')).split(';').filter(s=>s.trim()))await DB.prepare(sql).run();
  env={DB,SYNC_TOKEN:token,ADMIN_PASSWORD:'admin-test-password-32-characters',SITE_URL:'https://test.local',PREVIEW_ONLY:'false',ASSETS:{fetch:async()=>new Response('asset')}};
  stateFile=join(await mkdtemp(join(tmpdir(),'finhot-sync-')),'state.json');
});
beforeEach(async()=>{env.AUTH_RATE_LIMITER={limit:async()=>({success:true})};env.PUBLIC_RATE_LIMITER={limit:async()=>({success:true})};env.PREVIEW_ONLY='false';delete env.CACHE;delete env.PUBLIC_ONLY;delete env.SYNC_ONLY;for(const table of ['server_sync_items','server_sync_recent','server_sync_reports','server_sync_state','server_sync_stage','server_sync_versions','feedback','rate_limits','sync_incidents'])await env.DB.prepare(`DELETE FROM ${table}`).run();});
after(async()=>{await mf?.dispose();});
const item=(id:string,selected=1)=>({id,url:'https://example.com/'+id,source_id:'s',source_name:'来源',title:'测试公司 '+id,summary:selected?'公司披露公开经营数据，相关变化请以原文为准。':'',category:'market',selected,published_at:null,discovered_at:'2026-01-01T00:00:00.000Z',ready_at:null,state:selected?'ready':'awaiting-body',body_status:'pending',body_length:0,material_scope:''});
const metadata=(ids:string[])=>({sources:[{id:'s',name:'来源',group:'company',homepage:'https://example.com/',tier:'T1',intervalMinutes:30}],categories:{market:'市场'},groups:{company:'公司'},reports:[{date:'2026-01-01',created_at:'2026-01-01T00:00:00.000Z',ids}],summaryBudgetReached:false,budgets:[]});
test('long Chinese search is literal and case insensitive without LIKE limits',async()=>{
  const title='上市公司关于新材料项目投资建设进展情况的公开公告以及经营数据说明 ABC_%';
  await begin('search',['a']);await commit('search',[{...item('a'),title}]);
  for(const term of [title.slice(0,30),'abc_%','_%'])assert.equal((await (await request('/api/items?q='+encodeURIComponent(term))).json()).items.length,1);
  assert.equal((await request('/api/items?q='+encodeURIComponent('中'.repeat(81)))).status,400);
});
test('heartbeat does not disguise stopped collection, and incidents resolve without duplicates',async()=>{
  const now=Date.now(),stamp=new Date(now).toISOString();
  const old=new Date(now-4*3600000).toISOString();
  const state={generation:'one',capturedAt:old,contactAt:stamp,metadata:{...metadata([]),sources:[{...metadata([]).sources[0],checked_at:old}]}};
  assert.equal(syncedHealth(state,now).stale,false);assert.equal(syncedHealth(state,now).collectionDelayed,true);
  await begin('one',[],'',0,old,{metadata:state.metadata});await request('/_sync/commit',{generation:'one'});
  await env.DB.prepare("UPDATE server_sync_state SET contact_at=? WHERE key='active'").bind(old).run();
  await monitorSync(env.DB,now);await monitorSync(env.DB,now+1000);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM sync_incidents WHERE resolved_at IS NULL').first()).n,2);
  state.metadata.sources[0].checked_at=stamp;
  await env.DB.prepare("UPDATE server_sync_state SET contact_at=?,metadata_json=? WHERE key='active'").bind(stamp,JSON.stringify(state.metadata)).run();
  await monitorSync(env.DB,now+2000);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM sync_incidents WHERE resolved_at IS NULL').first()).n,0);
});
async function request(path:string,body?:unknown,auth=token){return worker.fetch(new Request('https://test.local'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+auth,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);}
async function begin(generation:string,ids:string[],baseGeneration='',expectedChanges=ids.length,capturedAt='2026-01-01T00:00:00.000Z',extra={}){return request('/_sync/begin',{generation,baseGeneration,expectedChanges,capturedAt,ids,metadata:metadata(ids),...extra});}
async function commit(generation:string,items:ReturnType<typeof item>[]){assert.equal((await request('/_sync/items',{generation,items})).status,200);return request('/_sync/commit',{generation});}
test('incomplete upload is invisible; complete commit and retries are idempotent',async()=>{
  assert.equal((await request('/_sync/head',undefined,'bad')).status,401);assert.equal((await begin('one',['a','b'])).status,200);
  await request('/_sync/items',{generation:'one',items:[item('a')]});assert.equal((await request('/api/items')).status,503);assert.equal((await request('/_sync/commit',{generation:'one'})).status,409);
  assert.equal((await commit('one',[item('b')])).status,200);assert.equal((await request('/_sync/commit',{generation:'one'})).status,200);
  assert.equal((await (await request('/api/items')).json()).items.length,2);
});
test('delta keeps unchanged rows, withdraws citations and rejects stale competing snapshot',async()=>{
  await begin('one',['a','b']);await commit('one',[item('a'),item('b')]);
  await begin('next',['a','b','c'],'one',1,'2026-01-02T00:00:00.000Z');await request('/_sync/items',{generation:'next',items:[item('c')]});
  assert.equal((await (await request('/api/items')).json()).items.length,2);
  await begin('withdraw',['b'],'one',0,'2026-01-03T00:00:00.000Z');assert.equal((await request('/_sync/commit',{generation:'withdraw'})).status,200);
  assert.equal((await request('/_sync/commit',{generation:'next'})).status,409);
  assert.deepEqual((await (await request('/api/items')).json()).items.map((i:any)=>i.id),['b']);
  assert.deepEqual((await (await request('/api/reports/2026-01-01')).json()).items.map((i:any)=>i.id),['b']);assert.ok(!(await (await request('/feed.xml')).text()).includes('https://example.com/a'));
});
test('a failed final database statement rolls the entire publication back',async()=>{
  await begin('one',['a']);await commit('one',[item('a')]);
  await begin('broken',['b'],'one',1,'2026-01-02T00:00:00.000Z');await request('/_sync/items',{generation:'broken',items:[item('b')]});
  await env.DB.prepare("CREATE TRIGGER reject_broken_commit BEFORE UPDATE ON server_sync_state WHEN NEW.generation='broken' BEGIN SELECT RAISE(ABORT,'simulated database failure'); END").run();
  try{assert.equal((await request('/_sync/commit',{generation:'broken'})).status,503);assert.equal((await (await request('/_sync/head')).json()).generation,'one');assert.deepEqual((await (await request('/api/items')).json()).items.map((i:any)=>i.id),['a']);}
  finally{await env.DB.prepare('DROP TRIGGER reject_broken_commit').run();}
});
test('public DTOs strip body and keys, filtering escapes wildcards, admin stays private',async()=>{
  const m:any=metadata(['a','raw']);m.sources[0].api_key='SOURCE_SECRET';m.private_key='PRIVATE_KEY';
  await begin('one',['a','raw'],'',2,undefined,{metadata:m});await commit('one',[{...item('a'),original_title:'测试公司 600325 披露原题',body_text:'PRIVATE_BODY',key:'MODEL_SECRET'} as any,item('raw',0)]);
  const text=await (await request('/api/items?all=1')).text();assert.ok(!/PRIVATE_BODY|MODEL_SECRET/.test(text));assert.equal(JSON.parse(text).items.length,2);
  assert.ok(!(await (await request('/api/sources')).text()).includes('SOURCE_SECRET'));assert.equal((await request('/api/admin/status',undefined,'bad')).status,401);
  assert.equal((await request('/api/admin/run',{kind:'model'},env.ADMIN_PASSWORD)).status,404);
  assert.equal((await (await request('/api/items?all=1&q=%25')).json()).items.length,0);assert.equal((await request('/api/items?group=invalid')).status,400);
  assert.equal((await (await request('/api/items?all=1&q=600325')).json()).items[0].id,'a');
  assert.match(await (await request('/feed.xml')).text(),/公司披露/);assert.ok(!(await (await request('/feed.xml')).text()).includes('https://example.com/raw'));
});
test('preview protects static assets; feedback is same-origin, limited and expires',async()=>{
  env.PREVIEW_ONLY='true';assert.equal((await request('/')).status,401);assert.equal((await request('/',undefined,env.ADMIN_PASSWORD)).status,200);
  env.PREVIEW_ONLY='false';const feedback=async(origin:string)=>worker.fetch(new Request('https://test.local/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({message:'这是用于验证站内反馈的说明。'})}),env);
  assert.equal((await feedback('https://outside.invalid')).status,403);for(let i=0;i<5;i++)assert.equal((await feedback('https://test.local')).status,201);assert.equal((await feedback('https://test.local')).status,429);
  await env.DB.prepare("UPDATE feedback SET created_at='2000-01-01T00:00:00.000Z'").run();await worker.scheduled({},env);assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM feedback').first()).n,0);
});
test('server client pushes once, uses heartbeat unchanged, handles lost local state, never fetches a source',async()=>{
  const paths:string[]=[];const fetcher=(async(url:any,init:any)=>{paths.push(new URL(url).pathname);return worker.fetch(new Request(url,init),env);}) as typeof fetch;
  const snapshot={capturedAt:'2026-01-01T00:00:00.000Z',items:[item('a'),item('b')],metadata:metadata(['a','b'])};
  const config={url:'https://test.local/',token,stateFile,fetcher};const first=await pushSnapshot(snapshot,config);assert.equal(first.changed,2);assert.equal((await stat(stateFile)).mode&0o777,0o600);
  paths.length=0;assert.equal((await pushSnapshot(snapshot,config)).unchanged,true);assert.deepEqual(paths,['/_sync/head','/_sync/heartbeat']);
  const later={...snapshot,capturedAt:'2026-01-01T01:00:00.000Z',reconcileCursor:'next-archive-batch'};
  assert.equal((await pushSnapshot(later,config)).unchanged,true);assert.equal(JSON.parse(await readFile(stateFile,'utf8')).reconcileCursor,'next-archive-batch');
  const changed={...snapshot,capturedAt:'2026-01-02T00:00:00.000Z',items:[item('b'),item('c')],metadata:metadata(['b','c'])};assert.equal((await pushSnapshot(changed,config)).changed,1);
  assert.equal((await pushSnapshot({...changed,capturedAt:'2026-01-03T00:00:00.000Z'},{...config,stateFile:stateFile+'.lost'})).changed,2);
  assert.deepEqual((await (await request('/api/items')).json()).items.map((i:any)=>i.id),['c','b']);
});
test('long summaries are split into byte-bounded upload chunks',async()=>{
  const sizes:number[]=[];const fetcher=(async(url:any,init:any)=>{if(new URL(url).pathname==='/_sync/items')sizes.push(Buffer.byteLength(init.body));return worker.fetch(new Request(url,init),env);}) as typeof fetch;
  const items=Array.from({length:30},(_,i)=>({...item('long-'+i),summary:'材料'.repeat(2400)}));
  const snapshot={capturedAt:'2026-01-01T00:00:00.000Z',items,metadata:metadata(items.map(i=>i.id))};
  await pushSnapshot(snapshot,{url:'https://test.local/',token,stateFile:stateFile+'.long',fetcher});assert.ok(sizes.length>1);assert.ok(sizes.every(n=>n<262144));
});
test('public cache hits read only the active pointer; withdrawals bypass the old generation',async()=>{
  await begin('one',['a']);await commit('one',[item('a')]);
  const stored=new Map<string,Response>();let puts=0;
  env.CACHE={match:async(r:Request)=>stored.get(r.url)?.clone(),put:async(r:Request,v:Response)=>{stored.set(r.url,v.clone());puts++;}};
  const DB=env.DB,reads:string[]=[];
  env.DB={prepare:(text:string)=>{reads.push(text);return DB.prepare(text);},batch:DB.batch.bind(DB)};
  try{
    assert.equal((await request('/api/items')).headers.get('x-finhot-cache'),'MISS');
    reads.length=0;const hit=await request('/api/items');assert.equal(hit.headers.get('x-finhot-cache'),'HIT');
    assert.equal(hit.headers.get('cache-control'),'no-store');assert.equal(reads.length,1);
    assert.match(reads[0],/SELECT generation/);
    await request('/api/health');assert.equal(puts,1,'health stays uncached');
    await request('/api/admin/status',undefined,env.ADMIN_PASSWORD);assert.equal(puts,1,'admin stays uncached');
    await begin('withdraw',[],'one',0,'2026-01-02T00:00:00.000Z');await request('/_sync/commit',{generation:'withdraw'});
    const fresh=await request('/api/items');assert.equal(fresh.headers.get('x-finhot-cache'),'MISS');assert.deepEqual((await fresh.json()).items,[]);
    env.PREVIEW_ONLY='true';const count=puts;await request('/api/items',undefined,env.ADMIN_PASSWORD);assert.equal(puts,count,'private preview bypasses public cache');
  }finally{env.DB=DB;}
});
test('articles and reports expose escaped HTML, canonical links and only current public summaries',async()=>{
  await begin('one',['a','raw']);await commit('one',[{...item('a'),title:'公司 <script>alert(1)</script>',summary:'公开摘要 </script><script>alert(2)</script>。\n第二段材料。',material_scope:'PDF 前 3 页'},item('raw',0)]);
  const response=await request('/articles/a?lang=zh-CN'),html=await response.text();assert.equal(response.status,200);
  assert.match(html,/<link rel="canonical" href="https:\/\/test.local\/articles\/a\?lang=zh-CN">/);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('</script><script>alert(2)'));assert.match(html,/第二段材料/);assert.match(html,/PDF 前 3 页/);assert.ok(!html.includes('src="/app.js"'));
  assert.match(await (await request('/articles/raw')).text(),/noindex,follow/);
  const sitemap=await (await request('/sitemap.xml')).text();assert.ok(sitemap.includes('/articles/a'));assert.ok(!sitemap.includes('/articles/raw'));assert.ok(sitemap.includes('/daily/2026-01-01'));
  assert.match(await (await request('/daily/2026-01-01?lang=zh-CN')).text(),/公开摘要/);assert.match(await (await request('/robots.txt')).text(),/Sitemap: https:\/\/test.local\/sitemap.xml/);
  assert.equal((await request('/articles/missing')).status,404);assert.equal((await request('/articles/a/invalid')).status,404);
  await begin('withdraw',[],'one',0,'2026-01-02T00:00:00.000Z');await request('/_sync/commit',{generation:'withdraw'});
  assert.equal((await request('/articles/a')).status,404);assert.ok(!(await (await request('/sitemap.xml')).text()).includes('/articles/a'));
  assert.ok(!(await (await request('/daily/2026-01-01?lang=zh-CN')).text()).includes('公开摘要'));
});
test('public and sync-only workers keep their separate boundaries',async()=>{
  env.PUBLIC_ONLY='true';assert.equal((await request('/_sync/head')).status,404);
  delete env.PUBLIC_ONLY;env.SYNC_ONLY='true';
  assert.equal((await request('/_sync/head')).status,200);assert.equal((await request('/')).status,404);
  assert.equal((await request('/style.css')).status,404);assert.equal((await request('/api/admin/status',undefined,env.ADMIN_PASSWORD)).status,404);
  assert.equal((await request('/_sync/head',undefined,'bad')).status,401);
});
test('cleartext requests are refused before authentication, limits or database access',async()=>{
  const DB=env.DB,auth=env.AUTH_RATE_LIMITER;let touches=0;
  env.DB={prepare:()=>{touches++;throw new Error('must not reach database');}};
  env.AUTH_RATE_LIMITER={limit:async()=>{touches++;return{success:true};}};
  try{
    for(const path of ['/_sync/head','/api/admin/status','/api/feedback']){
      const response=await worker.fetch(new Request('http://test.local'+path,{headers:{authorization:'Bearer '+token}}),env);
      assert.equal(response.status,426);assert.equal(response.headers.get('www-authenticate'),null);
      assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('cache-control'),'no-store');
    }
    env.PREVIEW_ONLY='true';assert.equal((await worker.fetch(new Request('http://test.local/'),env)).status,426);
    assert.equal(touches,0);
  }finally{env.DB=DB;env.AUTH_RATE_LIMITER=auth;}
});
test('auth rate limits apply before password validation and cannot be bypassed with X-Forwarded-For',async()=>{
  const keys:string[]=[];let remaining=2;
  env.AUTH_RATE_LIMITER={limit:async({key}:{key:string})=>{keys.push(key);return{success:remaining-->0};}};
  const attempt=(password:string,xff:string)=>worker.fetch(new Request('https://test.local/api/admin/status',{headers:{authorization:'Bearer '+password,'cf-connecting-ip':'203.0.113.1','x-forwarded-for':xff}}),env);
  assert.equal((await attempt('wrong','1.1.1.1')).status,401);
  assert.equal((await attempt('wrong','2.2.2.2')).status,401);
  const blocked=await attempt(env.ADMIN_PASSWORD,'3.3.3.3');assert.equal(blocked.status,429);
  assert.equal(blocked.headers.get('retry-after'),'60');assert.equal(blocked.headers.get('cache-control'),'no-store');
  assert.deepEqual(keys,Array(3).fill('admin:203.0.113.1'));
  delete env.AUTH_RATE_LIMITER;assert.equal((await request('/api/admin/status',undefined,env.ADMIN_PASSWORD)).status,503);
});
test('public quota protection refuses requests before a database read; admin is independent',async()=>{
  env.PUBLIC_RATE_LIMITER={limit:async()=>({success:false})};
  const DB=env.DB;let reads=0;
  env.DB={prepare:(sql:string)=>{reads++;return DB.prepare(sql);},batch:DB.batch.bind(DB)};
  try{
    for(const path of ['/api/items','/api/health','/articles/a','/sitemap.xml'])assert.equal((await request(path)).status,429);
    assert.equal(reads,0);assert.equal((await request('/api/admin/status',undefined,'bad')).status,401);
    assert.equal((await request('/')).status,200);
    delete env.PUBLIC_RATE_LIMITER;assert.equal((await request('/api/items')).status,503);
  }finally{env.DB=DB;}
});
test('cache canonicalization ignores noise and duplicate parameters but preserves meaningful queries',async()=>{
  await begin('one',['a']);await commit('one',[item('a')]);
  const stored=new Map<string,Response>();
  env.CACHE={match:async(r:Request)=>stored.get(r.url)?.clone(),put:async(r:Request,v:Response)=>{stored.set(r.url,v.clone());}};
  assert.equal((await request('/api/items?all=1')).headers.get('x-finhot-cache'),'MISS');
  const hit=await request('/api/items?noise=123&all=1&all=0&__finhot_generation=bad');
  assert.equal(hit.headers.get('x-finhot-cache'),'HIT');assert.equal((await hit.json()).items.length,1);
  assert.equal((await request('/api/items?all=1&q=missing')).headers.get('x-finhot-cache'),'MISS');
  assert.equal(stored.size,2);
});
test('security headers apply to successful responses and authorization errors',async()=>{
  for(const path of ['/','/api/admin/status','/_sync/head']){
    const response=await request(path,undefined,'bad');
    assert.equal(response.headers.get('strict-transport-security'),'max-age=86400');
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    assert.equal(response.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
    assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  }
});

test('rolling feed retains article and report URLs; explicit withdrawals still remove archived citations',async()=>{
  const fetcher=(async(url:any,init:any)=>worker.fetch(new Request(url,init),env)) as typeof fetch;
  const config={url:'https://test.local/',token,stateFile:stateFile+'.archive',fetcher};
  const first={capturedAt:'2026-01-01T00:00:00.000Z',items:[item('old'),item('current')],feedIds:['old','current'],visibleIds:['old','current'],metadata:{...metadata(['old']),archiveMode:'persistent'}};
  await pushSnapshot(first,config);
  const second={capturedAt:'2026-01-02T00:00:00.000Z',items:[item('current'),item('new')],feedIds:['current','new'],visibleIds:['old','current','new'],metadata:{...metadata([]),reports:[],archiveMode:'persistent'}};
  await pushSnapshot(second,config);
  assert.equal((await request('/articles/old')).status,200);assert.equal((await request('/daily/2026-01-01')).status,200);
  assert.deepEqual((await (await request('/api/items')).json()).items.map((i:any)=>i.id),['new','current']);
  assert.deepEqual((await (await request('/api/reports/2026-01-01')).json()).items.map((i:any)=>i.id),['old']);
  const withdrawal={...second,capturedAt:'2026-01-03T00:00:00.000Z',visibleIds:['current','new']};
  await pushSnapshot(withdrawal,{...config,stateFile:config.stateFile+'.lost'});
  assert.equal((await request('/articles/old')).status,404);
  assert.deepEqual((await (await request('/api/reports/2026-01-01')).json()).items,[]);
  assert.equal((await begin('legacy',['current'],'unused',0,'2026-01-04T00:00:00.000Z')).status,409,'legacy uploads cannot prune the archive');
});

test('empty selected report exposes a labelled source index, not fabricated selections',async()=>{
  const raw={...item('raw',0),category:'earnings'};
  const m:any={...metadata(['raw']),categories:{market:'市场',earnings:'财报业绩'}};
  m.reports[0].mode='source-index';
  await begin('fallback',['raw'],'',1,undefined,{metadata:m});await commit('fallback',[raw]);
  const report=await (await request('/api/reports/2026-01-01')).json();assert.equal(report.mode,'source-index');assert.equal(report.items[0].selected,0);
  const html=await (await request('/daily/2026-01-01?lang=zh-CN')).text();assert.match(html,/暂无精选/);assert.match(html,/来源索引/);
  assert.equal((await (await request('/api/items')).json()).items.length,0);
  assert.equal((await (await request('/api/items?all=1&category=earnings')).json()).items.length,1);
});

test('today filter changes cache identity and rejects malformed timestamps',async()=>{
  await begin('dates',['old','new']);await commit('dates',[item('old'),{...item('new'),published_at:'2026-01-02T12:00:00.000Z'}]);
  const stored=new Map<string,Response>();env.CACHE={match:async(r:Request)=>stored.get(r.url)?.clone(),put:async(r:Request,v:Response)=>{stored.set(r.url,v.clone());}};
  const from=encodeURIComponent('2026-01-02T00:00:00.000Z');
  assert.equal((await (await request('/api/items?all=1&from='+from)).json()).items.length,1);
  assert.equal((await (await request('/api/items?all=1')).json()).items.length,2);
  assert.equal((await request('/api/items?from=not-a-date')).status,400);assert.equal(stored.size,2);
});

// Measure real SQLite/D1 row reads, including first() and transactional writes.
function measuredDb(db:any){
  const reads:{sql:string;rows:number}[]=[];
  const record=(sql:string,result:any)=>{reads.push({sql,rows:result.meta.rows_read});return result;};
  const wrap=(raw:any,sql:string):any=>({raw,sql,bind:(...args:any[])=>wrap(raw.bind(...args),sql),
    all:async()=>record(sql,await raw.all()),run:async()=>record(sql,await raw.run()),
    first:async(column?:string)=>{const result=record(sql,await raw.all()).results[0];return result?(column?result[column]:result):null;}});
  return {reads,db:{prepare:(sql:string)=>wrap(db.prepare(sql),sql),batch:async(statements:any[])=>{
    const results=await db.batch(statements.map(s=>s.raw));return results.map((r:any,i:number)=>record(statements[i].sql,r));
  }}};
}

test('metadata-only sync reuses the committed manifest without scanning unchanged articles',async()=>{
  const items=Array.from({length:600},(_,i)=>item('scale-'+String(i).padStart(4,'0'))),ids=items.map(i=>i.id);
  const fetcher=(async(url:any,init:any)=>worker.fetch(new Request(url,init),env)) as typeof fetch;
  await pushSnapshot({capturedAt:'2026-01-01T00:00:00.000Z',items,feedIds:ids,visibleIds:ids,metadata:{...metadata([]),archiveMode:'persistent'}},
    {url:'https://test.local/',token,stateFile:stateFile+'.scale',fetcher});
  const extra={metadata:{...metadata([]),archiveMode:'persistent'},feedIds:ids};
  assert.equal((await begin('metadata-only',ids,(await (await request('/_sync/head')).json()).generation,0,'2026-01-02T00:00:00.000Z',extra)).status,200);
  const original=env.DB,measured=measuredDb(original);env.DB=measured.db;
  try{
    assert.equal((await request('/_sync/commit',{generation:'metadata-only'})).status,200);
    assert.ok(measured.reads.reduce((n,r)=>n+r.rows,0)<60,JSON.stringify(measured.reads));
    assert.ok(!measured.reads.some(r=>r.sql.includes('FROM json_each(?) j')));
  }finally{env.DB=original;}
  // Inherited IDs do not let a new, unuploaded ID pass completeness validation.
  await begin('missing',[...ids,'missing'],'metadata-only',0,'2026-01-03T00:00:00.000Z',extra);
  assert.equal((await request('/_sync/commit',{generation:'missing'})).status,409);
  assert.equal((await (await request('/_sync/head')).json()).generation,'metadata-only');
});

test('missing base manifest falls back to validation and withdrawn IDs cannot be inherited',async()=>{
  await begin('one',['a','b']);await commit('one',[item('a'),item('b')]);
  await begin('withdraw',['b'],'one',0,'2026-01-02T00:00:00.000Z');assert.equal((await request('/_sync/commit',{generation:'withdraw'})).status,200);
  await begin('restore',['a','b'],'withdraw',0,'2026-01-03T00:00:00.000Z');assert.equal((await request('/_sync/commit',{generation:'restore'})).status,409);
  await env.DB.prepare("DELETE FROM server_sync_versions WHERE generation='withdraw'").run();
  await begin('fallback',['b'],'withdraw',0,'2026-01-04T00:00:00.000Z');assert.equal((await request('/_sync/commit',{generation:'fallback'})).status,200);
  await env.DB.prepare("DELETE FROM server_sync_versions WHERE generation='fallback'").run();
  await begin('missing',['absent'],'fallback',0,'2026-01-05T00:00:00.000Z');assert.equal((await request('/_sync/commit',{generation:'missing'})).status,409);
});

test('feed queries stop at the page boundary and preserve filters, ordering and archive exclusion',async()=>{
  // A real large feed with ties in dates makes a full ID-subquery sort expensive.
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1200)
    INSERT INTO server_sync_items(id,source_id,category,selected,sort_at,search_text,data_json)
    SELECT printf('item-%04d',n),CASE WHEN n%2=0 THEN 's' ELSE 'other' END,
      CASE WHEN n%3=0 THEN 'market' ELSE 'research' END,n%2,'2026-01-01T00:00:00.000Z','test '||n,
      json_object('id',printf('item-%04d',n)) FROM seq`).run();
  await env.DB.prepare("INSERT INTO server_sync_recent SELECT id FROM server_sync_items WHERE id<='item-1000'").run();
  const cases:[any,string,any[]][]=[
    [{all:true},'1=1',[]], [{},'selected=1',[]],
    [{all:true,category:'market'},'category=?',['market']],
    [{all:true,sourceIds:['s']},'source_id IN (?)',['s']],
    [{all:true,sourceIds:['s','other'],offset:40},'source_id IN (?,?)',['s','other']],
    [{all:true,search:'test 99'},'instr(lower(search_text),lower(?))>0',['test 99']],
    [{all:true,from:'2026-01-02T00:00:00.000Z'},'sort_at>=?',['2026-01-02T00:00:00.000Z']],
    [{all:true,sourceIds:[]},'0=1',[]],
  ];
  for(const [options,where,params] of cases){
    const old=await env.DB.prepare(`SELECT data_json FROM server_sync_items WHERE ${where} AND id IN(SELECT id FROM server_sync_recent) ORDER BY sort_at DESC,id DESC LIMIT 21 OFFSET ?`).bind(...params,options.offset??0).all();
    const measured=measuredDb(env.DB),result=await syncedItems(measured.db as any,options);
    assert.deepEqual(result.items,old.results.slice(0,20).map((r:any)=>JSON.parse(r.data_json)));
    assert.equal(result.hasMore,old.results.length>20);
    if(Object.keys(options).length===1&&options.all){
      const reads=measured.reads.reduce((n,r)=>n+r.rows,0);
      assert.ok(reads<old.meta.rows_read/4,`old=${old.meta.rows_read}, new=${reads}`);
    }
  }
});

 test('English content survives sync, search and language-specific HTML caching',async()=>{
  await begin('english',['a']);await commit('english',[{...item('a'),title_en:'Company announces earnings',summary_en:'Revenue rose by 30%.'} as any]);
  const stored=new Map<string,Response>();env.CACHE={match:async(r:Request)=>stored.get(r.url)?.clone(),put:async(r:Request,v:Response)=>{stored.set(r.url,v.clone());}};
  const en=await request('/articles/a?lang=en'),text=await en.text();assert.match(text,/Company announces earnings/);assert.match(text,/inLanguage":"en"/);
  const zh=await request('/articles/a?lang=zh-CN');assert.equal(zh.headers.get('x-finhot-cache'),'MISS');assert.match(await zh.text(),/测试公司/);
  const hit=await request('/articles/a?lang=en');assert.equal(hit.headers.get('x-finhot-cache'),'HIT');assert.match(await hit.text(),/Revenue rose by 30%/);
  assert.equal((await (await request('/api/items?q=earnings')).json()).items[0].id,'a');
  assert.match(await (await request('/daily/2026-01-01?lang=en')).text(),/Company announces earnings/);
});

test('lost commit response is recovered without reuploading or replacing the generation',async()=>{
  const {writeFile}=await import('node:fs/promises');
  const file=stateFile+'.ack-lost';let fail=true;const uploads:string[]=[];
  const fetcher=(async(url:any,init:any)=>{const path=new URL(url).pathname;if(path==='/_sync/items')uploads.push(init.body);const r=await worker.fetch(new Request(url,init),env);if(path==='/_sync/commit'&&fail){fail=false;throw Error('response lost after commit');}return r;}) as typeof fetch;
  const snapshot={capturedAt:'2026-01-01T00:00:00.000Z',items:[item('a')],metadata:metadata(['a'])},config={url:'https://test.local/',token,stateFile:file,fetcher};
  await assert.rejects(pushSnapshot(snapshot,config),/response lost/);
  assert.equal((await pushSnapshot(snapshot,config)).deferred,true);
  const pending=JSON.parse(await readFile(file+'.pending','utf8'));pending.retryAt=0;await writeFile(file+'.pending',JSON.stringify(pending));
  assert.equal((await pushSnapshot(snapshot,config)).recovered,true);assert.equal(uploads.length,1);
  assert.equal(JSON.parse(await readFile(file,'utf8')).generation,pending.begin.generation);
  await assert.rejects(stat(file+'.pending'),{code:'ENOENT'});
});
test('failed chunk resumes only unconfirmed chunks and commit errors do not restage',async()=>{
  const {writeFile}=await import('node:fs/promises');const file=stateFile+'.chunk-resume';let chunkFail=true,commitFail=true;const uploads:string[]=[];
  const fetcher=(async(url:any,init:any)=>{const path=new URL(url).pathname;
    if(path==='/_sync/items'){const ids=JSON.parse(init.body).items.map((i:any)=>i.id).join(',');uploads.push(ids);if(ids==='r30'&&chunkFail){chunkFail=false;return new Response('temporary',{status:503});}}
    if(path==='/_sync/commit'&&commitFail){commitFail=false;return new Response('temporary',{status:503});}
    return worker.fetch(new Request(url,init),env);
  }) as typeof fetch;
  const items=Array.from({length:31},(_,i)=>item('r'+i));const snapshot={capturedAt:'2026-01-01T00:00:00.000Z',items,metadata:metadata(items.map(i=>i.id))},config={url:'https://test.local/',token,stateFile:file,fetcher};
  const release=async()=>{const p=JSON.parse(await readFile(file+'.pending','utf8'));p.retryAt=0;await writeFile(file+'.pending',JSON.stringify(p));return p;};
  await assert.rejects(pushSnapshot(snapshot,config));const first=await release();assert.equal(first.uploaded,1);
  await assert.rejects(pushSnapshot(snapshot,config));const second=await release();assert.equal(second.begin.generation,first.begin.generation);assert.equal(second.uploaded,2);
  assert.equal((await pushSnapshot(snapshot,config)).changed,31);assert.equal(uploads.length,3);assert.equal(uploads.filter(s=>s.includes('r0')).length,1);
});
test('scheduled staging cleanup is bounded and retains manifests with remaining rows',async()=>{
  await begin('old',Array.from({length:150},(_,i)=>'old'+i),'',150);
  for(let i=0;i<150;i+=30)await request('/_sync/items',{generation:'old',items:Array.from({length:30},(_,n)=>item('old'+(n+i)))});
  await env.DB.prepare("UPDATE server_sync_versions SET created_at='2000-01-01T00:00:00.000Z'").run();
  await worker.scheduled({},env);assert.equal((await env.DB.prepare('SELECT count(*) n FROM server_sync_stage').first()).n,50);assert.equal((await env.DB.prepare('SELECT count(*) n FROM server_sync_versions').first()).n,1);
  await worker.scheduled({},env);assert.equal((await env.DB.prepare('SELECT count(*) n FROM server_sync_stage').first()).n,0);assert.equal((await env.DB.prepare('SELECT count(*) n FROM server_sync_versions').first()).n,0);
});
test('expired manifests give back their id lists while their staging rows drain',async()=>{
  await begin('bulky',Array.from({length:150},(_,i)=>'bulky'+i),'',150);
  for(let i=0;i<150;i+=30)await request('/_sync/items',{generation:'bulky',items:Array.from({length:30},(_,n)=>item('bulky'+(n+i)))});
  await begin('recent',['recent0'],'',0);
  await env.DB.prepare("UPDATE server_sync_versions SET created_at='2000-01-01T00:00:00.000Z' WHERE generation='bulky'").run();
  await worker.scheduled({},env);
  const lists=async(g:string)=>await env.DB.prepare('SELECT ids_json,metadata_json,feed_ids_json FROM server_sync_versions WHERE generation=?').bind(g).first();
  assert.deepEqual(await lists('bulky'),{ids_json:'[]',metadata_json:'{}',feed_ids_json:null},'kept for its 50 staging rows, without its lists');
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM server_sync_stage WHERE generation='bulky'").first()).n,50);
  assert.equal((await lists('recent'))!.ids_json,'["recent0"]','a manifest of the last day is untouched');
});
test('manifests begun before the active one expire at once; a later upload keeps its day',async()=>{
  const at=(g:string,t:string)=>env.DB.prepare('UPDATE server_sync_versions SET created_at=? WHERE generation=?').bind(t,g).run();
  const now=Date.now(),ago=(m:number)=>new Date(now-m*60000).toISOString();
  await begin('first',['a']);await commit('first',[item('a')]);await at('first',ago(10));
  await begin('abandoned',['a','b'],'first',1,'2026-01-02T00:00:00.000Z');await request('/_sync/items',{generation:'abandoned',items:[item('b')]});await at('abandoned',ago(8));
  await begin('second',['a','c'],'first',1,'2026-01-03T00:00:00.000Z');await commit('second',[item('c')]);await at('second',ago(6));
  await begin('uploading',['a','c','d'],'second',1,'2026-01-04T00:00:00.000Z');await request('/_sync/items',{generation:'uploading',items:[item('d')]});await at('uploading',ago(2));
  await worker.scheduled({},env);
  const left=(await env.DB.prepare('SELECT generation,ids_json FROM server_sync_versions ORDER BY created_at').all()).results;
  assert.deepEqual(left.map((v:any)=>v.generation),['second','uploading'],'superseded manifests and their staging rows are gone');
  assert.equal(left[1].ids_json,'["a","c","d"]');
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM server_sync_stage WHERE generation='uploading'").first()).n,1);
  assert.equal((await request('/_sync/commit',{generation:'uploading'})).status,200);
});
test('expired interrupted staging is rebuilt under a fresh generation',async()=>{
  const {writeFile}=await import('node:fs/promises');const file=stateFile+'.expired';let fail=true;
  const fetcher=(async(url:any,init:any)=>{if(new URL(url).pathname==='/_sync/commit'&&fail){fail=false;return new Response('temporary',{status:503});}return worker.fetch(new Request(url,init),env);}) as typeof fetch;
  const snapshot={capturedAt:'2026-01-01T00:00:00.000Z',items:[item('a')],metadata:metadata(['a'])},config={url:'https://test.local/',token,stateFile:file,fetcher};
  await assert.rejects(pushSnapshot(snapshot,config));const p=JSON.parse(await readFile(file+'.pending','utf8'));p.retryAt=0;p.startedAt=Date.now()-25*3600000;await writeFile(file+'.pending',JSON.stringify(p));
  await env.DB.prepare('DELETE FROM server_sync_stage').run();await env.DB.prepare('DELETE FROM server_sync_versions').run();
  const result=await pushSnapshot(snapshot,config);assert.equal(result.changed,1);assert.notEqual(result.generation,p.begin.generation);assert.equal((await (await request('/api/items')).json()).items.length,1);
});

test('staging cleanup scans eligible generations before the large unexpired backlog',async()=>{
  await begin('recentbacklog',[]);
  await env.DB.prepare("INSERT INTO server_sync_stage(generation,id,source_id,category,selected,sort_at,search_text,data_json) WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000) SELECT 'recentbacklog','bulk'||x,'s','market',0,'2026-01-01','','{}' FROM n").run();
  await begin('expiredsmall',['a']);await request('/_sync/items',{generation:'expiredsmall',items:[item('a')]});
  await env.DB.prepare("UPDATE server_sync_versions SET created_at='2000-01-01T00:00:00.000Z' WHERE generation='expiredsmall'").run();
  const original=env.DB,metrics:any[]=[];
  env.DB={prepare:original.prepare.bind(original),batch:async(statements:any[])=>{const results=await original.batch(statements);metrics.push(...results.map((r:any)=>r.meta));return results;}};
  try{await worker.scheduled({},env);}finally{env.DB=original;}
  assert.ok(metrics.reduce((n,m)=>n+m.rows_read,0)<100,'cleanup must not scan the 3000 unexpired staging rows');
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM server_sync_stage WHERE generation='recentbacklog'").first()).n,3000);
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM server_sync_stage WHERE generation='expiredsmall'").first()).n,0);
});
