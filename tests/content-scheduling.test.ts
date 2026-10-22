import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {queueProcessing,processArticle,refreshAnalysisPriorities,refreshReviewPriorities} from '@aihot/backend/jobs/content';
import {stopBoss,QUEUES,enqueue} from '@aihot/backend/jobs/queue';
const source='schedule-'+tag();
after(async()=>{await stopBoss();await closeDb();});
test('unfinished paid live work resumes first, history remains behind live work, and completed revisions are not reanalysed',async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'Scheduling fixture','rss','T1','editorial')`;
  const ids:string[]=[];
  for(const name of ['fresh','partial','history','finished']){
    const row=await upsertMaterial({sourceId:source,url:`https://example.org/${source}/${name}`,title:name,bodyText:'上市公司披露经营数据和项目进展。'.repeat(10),bodyStatus:'ok',publishedAt:new Date(),via:'import'});
    ids.push(row.articleId);
  }
  const [fresh,partial,history,finished]=ids;
  for(const id of [partial!,history!])await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,origin)
    VALUES(${tag()},'llm','prefilter_article',${'article:'+id+'@1'},'received','live')`;
  await sql`UPDATE articles SET backfill=true,published_at=now()-interval '72 hours' WHERE id=${history!}`;
  for(const id of [fresh!,partial!,history!]){await sql`UPDATE articles SET backfill=false WHERE id=${id} AND id<>${history!}`;await queueProcessing(id);}
  await refreshAnalysisPriorities();
  const jobs=await sql`SELECT data->>'articleId' AS id,priority FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=ANY(${ids.slice(0,3)}) ORDER BY priority DESC`;
  assert.deepEqual(jobs.map(j=>j.id),[partial,fresh,history]);assert.deepEqual(jobs.map(j=>j.priority),[10,0,-2]);
  const today=await upsertMaterial({sourceId:source,url:`https://example.org/${source}/today-import`,title:'今日首次导入',bodyText:'上市公司今日披露经营数据。'.repeat(10),bodyStatus:'ok',publishedAt:new Date(),via:'import'});
  await sql`UPDATE articles SET backfill=true WHERE id=${today.articleId}`;
  await queueProcessing(today.articleId);await refreshAnalysisPriorities();
  const [todayJob]=await sql`SELECT priority FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${today.articleId}`;
  assert.equal(todayJob!.priority,0,'first import of today\'s news remains live work');
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected) VALUES(${finished!},1,'rule','pass','已有摘要','公开资料摘要',false)`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${finished!}`;
  const [{n:before}]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  assert.equal(await queueProcessing(finished!),null);assert.equal((await processArticle(finished!)).state,'already-analyzed');
  const [{n:after}]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;assert.equal(after,before);
  assert.ok(await queueProcessing(finished!,{attemptTag:'explicit-'+tag()}),'an explicit manual re-evaluation still works');
});


test('review ordering finishes a paid chain before fresh work and alternates sources by recency',async()=>{
  const other='review-'+tag();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${other},'Review fixture','rss','T1','editorial')`;
  const ids:string[]=[];
  for(const [i,sourceId] of [source,source,other,other].entries()){
    const {articleId}=await upsertMaterial({sourceId,url:`https://example.org/${other}/${i}`,title:'评审排序'+i,
      bodyText:'上市公司披露经营数据。'.repeat(10),bodyStatus:'ok',publishedAt:new Date(Date.now()-i*3600000),via:'fetch'});
    ids.push(articleId);await enqueue(QUEUES.review,{articleId},{singletonKey:articleId});
  }
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,origin)
    VALUES(${tag()},'llm','score_article',${'article:'+ids[3]+'@1'},'received','live')`;
  await refreshReviewPriorities();
  const jobs=await sql`SELECT data->>'articleId' AS id,priority FROM pgboss.job
    WHERE name=${QUEUES.review} AND data->>'articleId'=ANY(${ids}::text[]) ORDER BY priority DESC`;
  const priority=(id:string)=>jobs.find(j=>j.id===id)!.priority;
  assert.equal(jobs[0].id,ids[3]);assert.equal(priority(ids[0]!),priority(ids[2]!));
  assert.ok(priority(ids[0]!)>priority(ids[1]!));
});
