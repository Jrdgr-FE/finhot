import {tag} from './setup.ts';
import http from 'node:http';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {config} from '@aihot/backend/config';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {recoverBodies} from '@aihot/backend/jobs/body-recovery';
import {extractArticleBody} from '@aihot/backend/content/extract';
const source='body-recovery-'+tag();
after(closeDb);
test('legacy failed bodies recover without a provider call; retries are bounded and retain readable failure reasons',async()=>{
  const text='上市公司发布年度经营情况说明，披露主营业务收入、项目建设进度与董事会决议。'.repeat(20);
  const server=http.createServer((req,res)=>{if(req.url==='/blocked'){res.writeHead(403,{'content-type':'text/html'});res.end('Denied');}else{res.writeHead(200,{'content-type':'text/html'});res.end('<html><head><title>经营情况说明</title></head><body><article><h1>经营情况说明</h1><p>'+text+'</p></article></body></html>');}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
  const allow=config.allowPrivateNetworkFetch;config.allowPrivateNetworkFetch=true;
  try{
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'Body recovery fixture','rss','T1','editorial')`;
    const good=await upsertMaterial({sourceId:source,url:base+'/body',title:'经营情况说明',bodyStatus:'unconfirmed',via:'import'});
    const bad=await upsertMaterial({sourceId:source,url:base+'/blocked',title:'无法访问正文',bodyStatus:'unconfirmed',via:'import'});
    await sql`UPDATE articles SET body_status='pending',material_scope='feed' WHERE id=${good.articleId}`;
    const [{n:before}]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
    const result=await recoverBodies(5,false,source);assert.equal(result.attempted,2);assert.equal(result.recovered,1);
    const [a]=await sql`SELECT body_status,body_text,body_fetch_attempts FROM articles WHERE id=${good.articleId}`;assert.equal(a.body_status,'ok');assert.ok(a.body_text.includes('经营情况'));assert.equal(a.body_fetch_attempts,1);
    const [b]=await sql`SELECT body_status,body_failure FROM articles WHERE id=${bad.articleId}`;assert.equal(b.body_status,'unconfirmed');assert.equal(b.body_failure,'原文返回 HTTP 403');
    assert.equal((await recoverBodies(5,false,source)).attempted,0);
    await sql`UPDATE articles SET body_fetch_attempts=3,body_checked_at=now()-interval '2 hours' WHERE id=${bad.articleId}`;
    assert.equal((await recoverBodies(5,false,source)).attempted,0);
    assert.equal(await extractArticleBody(good.articleId,false),'skipped');
    const [{n:after}]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;assert.equal(after,before);
  }finally{config.allowPrivateNetworkFetch=allow;await new Promise<void>(r=>server.close(()=>r()));}
});
