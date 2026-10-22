import { tag,stub } from './setup.ts';
import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import { sql,closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { purgeExpiredEdgeFeedback } from '@aihot/backend/operations/edge';
import { buildApp } from '../apps/api/src/app.ts';
import { collectSource } from '@aihot/backend/sources/collect';
import { config } from '@aihot/backend/config';
import { edgeSnapshot } from '@aihot/backend/publication/edge';

const T=tag(),SOURCE='cninfo-company',secret=`edge-secret-${T}`;
process.env.FINHOT_ORIGIN_TOKEN=secret;
const app=await buildApp(),headers={'x-finhot-origin-token':secret};
let id:string;
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${SOURCE},'Company disclosure','json_list','T1','editorial',false) ON CONFLICT(id) DO NOTHING`;
  const material=await upsertMaterial({sourceId:SOURCE,url:`https://example.org/edge-${T}`,title:`Original ${T}`,excerpt:'PRIVATE EVIDENCE',bodyText:'PRIVATE BODY',bodyStatus:'unconfirmed',via:'import',publishedAt:new Date()});id=material.articleId;
  await publishArticle(id);
});
after(async()=>{delete process.env.FINHOT_ORIGIN_TOKEN;await app.close();await stopBoss();await closeDb();});
test('the origin refuses anonymous requests and keeps pending private material out of the frontend DTO',async()=>{
  assert.equal((await app.inject({url:'/_edge/items'})).statusCode,401);
  const response=await app.inject({url:`/_edge/items?all=1&source=${SOURCE}&q=${T}`,headers});
  assert.equal(response.statusCode,200);const data=response.json();assert.equal(data.items.length,1);assert.equal(data.items[0].title,`Original ${T}`);assert.equal(data.items[0].summary,'');assert.ok(!response.body.includes('PRIVATE'));assert.ok(!('excerpt' in data.items[0]));
  assert.equal((await app.inject({url:'/_edge/items?group=unknown',headers})).statusCode,400);
  assert.equal((await app.inject({url:'/_edge/items?offset=-1',headers})).statusCode,400);
  assert.equal((await app.inject({url:'/_edge/reports/2026-02-31',headers})).statusCode,400);
});
test('fresh collection appears in all items before body extraction or paid analysis',async()=>{
  const provider=await stub(()=>[{title:`新收录公司公告 ${T}`,id:`collected-${T}`}]);
  const previous=config.allowPrivateNetworkFetch;config.allowPrivateNetworkFetch=true;
  try {
    await sql`UPDATE sources SET config=${sql.json({url:provider.url,itemsPath:'',titlePaths:['title'],urlTemplate:'https://example.org/{id}'} as never)} WHERE id=${SOURCE}`;
    const result=await collectSource(SOURCE);assert.equal(result.created,1);
    const response=await app.inject({url:`/_edge/items?all=1&source=${SOURCE}&q=${encodeURIComponent(`新收录公司公告 ${T}`)}`,headers});
    assert.equal(response.json().items[0].title,`新收录公司公告 ${T}`);assert.equal(response.json().items[0].state,'awaiting-body');assert.equal(response.json().items[0].summary,'');
    const exported=(await edgeSnapshot()).items.find((i:any)=>i.id===response.json().items[0].id);assert.equal(exported.original_title,`新收录公司公告 ${T}`);
  } finally {config.allowPrivateNetworkFetch=previous;await provider.close();}
});
test('published summaries keep source filters and material scope; withdrawing them removes every edge exit',async()=>{
  await sql`UPDATE articles SET material_scope='PDF 前 3 页（共 8 页）' WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','market',${`Title ${T}`},'PUBLIC SUMMARY',90,true)`;
  await publishArticle(id,{releasedAt:new Date(Date.now()-60000)});
  let response=await app.inject({url:`/_edge/items?source=${SOURCE}&group=company&q=${T}`,headers});
  assert.equal(response.json().items[0].summary,'PUBLIC SUMMARY');assert.equal(response.json().items[0].material_scope,'PDF 前 3 页（共 8 页）');
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  response=await app.inject({url:`/_edge/items?all=1&q=${encodeURIComponent(`Title ${T}`)}`,headers});assert.equal(response.json().items.length,0);
  assert.ok(!(await app.inject({url:'/_edge/feed.xml',headers})).body.includes(T));
  assert.equal((await app.inject({url:'/_edge/admin/status',headers})).statusCode,401);
});
test('server sync exports only currently listed DTOs and performs no paid call',async()=>{
  const [{n:before}]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  await sql`UPDATE publications SET visibility='public',visible_after=now()+interval '1 hour' WHERE article_id=${id}`;
  let snapshot=await edgeSnapshot();assert.ok(!snapshot.items.some((i:any)=>i.id===id));
  await sql`UPDATE publications SET visible_after=now()-interval '1 minute' WHERE article_id=${id}`;
  snapshot=await edgeSnapshot();const dto=snapshot.items.find((i:any)=>i.id===id);assert.equal(dto.summary,'PUBLIC SUMMARY');assert.ok(!('body_text' in dto));assert.ok(!JSON.stringify(dto).includes('PRIVATE'));
  // A finance-only DTO is unchanged by domains (no re-upload of the synced feed); others carry them.
  assert.ok(!('domains' in dto)&&!('primary_domain' in dto));
  await sql`UPDATE publications SET domains='{finance,ai}',primary_domain='finance' WHERE article_id=${id}`;
  const both=(await edgeSnapshot()).items.find((i:any)=>i.id===id);assert.deepEqual([both.domains,both.primary_domain],[['finance','ai'],'finance']);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  assert.ok(!(await edgeSnapshot()).items.some((i:any)=>i.id===id));
  const [{n:after}]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;assert.equal(after,before);
});
test('feedback is private, limited atomically and only edge feedback expires after 30 days',async()=>{
  const payload={message:`问题说明与原文链接 ${T}`,contact:'昵称或邮箱'};
  const post=()=>app.inject({method:'POST',url:'/_edge/feedback',headers:{...headers,'x-finhot-client-ip':`test-${T}`},payload});
  const responses=await Promise.all(Array.from({length:6},post));
  assert.equal(responses.filter(r=>r.statusCode===201).length,5);assert.equal(responses.filter(r=>r.statusCode===429).length,1);
  const rows=await sql`SELECT id,content,email FROM feedback WHERE content=${payload.message}`;assert.equal(rows.length,5);assert.equal(rows[0].email,payload.contact);
  await sql`UPDATE feedback SET created_at=now()-interval '31 days' WHERE id=${rows[0].id}`;
  assert.equal(await purgeExpiredEdgeFeedback(),1);
  assert.equal((await sql`SELECT id FROM feedback WHERE content=${payload.message}`).length,4);
});
